using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace QSAIWorker;

/// <summary>
/// デュアルモデル背景透過エンジン。
///
/// target="complex" (人物/アニメ)   → isnetis.onnx  1024×1024  ÷255 正規化のみ
/// target="simple"  (マスコット)     → u2net.onnx     320×320  ImageNet 正規化
/// target="logo"    (テキスト/ロゴ)  → モデル不要: 色差ベース除去 + RefineLogoMask
///
/// 共通ポスト処理:
///   Min-Max 正規化 → ResizeMask → Dual Threshold → RGBA PNG
///   ロゴのみ: ExtractLogoByColorDiff → RefineLogoMask (gentle) → RGBA PNG
/// </summary>
public class BGRemovalEngine : IDisposable
{
    // ── isnetis (complex / 人物・アニメ) ────────────────────────
    private const int ISNET_SIZE = 1024;
    private readonly string            _isnetPath;
    private          InferenceSession? _isnetSession;

    // ── U2-Net (simple / マスコット・汎用) ──────────────────────
    private const int U2NET_SIZE = 320;
    private static readonly float[] U2NET_MEAN = [0.485f, 0.456f, 0.406f];
    private static readonly float[] U2NET_STD  = [0.229f, 0.224f, 0.225f];
    private readonly string            _u2netPath;
    private          InferenceSession? _u2netSession;

    private readonly object _lock = new();

    // ── Dual Threshold パラメータ ──────────────────────────────
    private const int ComplexLower = 30;
    private const int ComplexUpper = 150;
    private const int SimpleLower  = 0;
    private const int SimpleUpper  = 255;

    public BGRemovalEngine(string modelsDir)
    {
        _isnetPath = Path.Combine(modelsDir, "isnetis.onnx");
        _u2netPath = Path.Combine(modelsDir, "u2net.onnx");
    }

    // complex モード用モデル（isnetis）が存在すれば Ready とする
    public bool IsModelReady() => File.Exists(_isnetPath);

    // ── Public API ──────────────────────────────────────────────

    public async Task RemoveBgAsync(string inputPath, string outputPath, string target = "complex")
    {
        bool isLogo   = target == "logo";
        bool isSimple = target == "simple";
        int lower = isSimple ? SimpleLower  : ComplexLower;
        int upper = isSimple ? SimpleUpper  : ComplexUpper;

        Image<Rgb24>? image = null;
        try
        {
            try
            {
                image = await Image.LoadAsync<Rgb24>(inputPath);
            }
            catch (OutOfMemoryException)
            {
                throw new InvalidOperationException(
                    "メモリ不足: 画像の読み込みに失敗しました。画像を縮小してから再試行してください。");
            }

            int origW = image.Width, origH = image.Height;
            byte[] alphaMask;

            try
            {
                if (isLogo)
                {
                    // ── 色差ベースのロゴ背景除去 ──────────────────────────────
                    // MODNet は Portrait Matting 専用モデルのためロゴ/テキストには不適。
                    // 四隅色差 + RefineLogoMask のみを使用する。
                    Console.Error.WriteLine($"[BGEngine] target=logo engine=ColorDiff size={origW}×{origH}");
                    var preAlpha = ExtractLogoByColorDiff(image, origW, origH);
                    alphaMask = RefineLogoMask(preAlpha, origW, origH, gentle: true);
                }
                else
                {
                    // ── 既存の standard パス (simple / complex) ──────────────
                    float[] rawMask;
                    int     modelSize;
                    if (isSimple)
                    {
                        if (!File.Exists(_u2netPath))
                            throw new FileNotFoundException("u2net.onnx が見つかりません。一度 complex モードでモデルをダウンロードしてください。");
                        modelSize = U2NET_SIZE;
                        rawMask   = RunInference(PrepareInputU2Net(image), modelSize, GetOrCreateU2Net());
                    }
                    else
                    {
                        modelSize = ISNET_SIZE;
                        rawMask   = RunInference(PrepareInputIsnet(image), modelSize, GetOrCreateIsnet());
                    }

                    float rawMin = float.MaxValue, rawMax = float.MinValue, rawSum = 0;
                    foreach (var v in rawMask) { if (v < rawMin) rawMin = v; if (v > rawMax) rawMax = v; rawSum += v; }
                    Console.Error.WriteLine(
                        $"[BGEngine] target={target} model={( isSimple ? "u2net" : "isnetis" )} lower={lower} upper={upper}");
                    Console.Error.WriteLine(
                        $"[BGEngine] raw mask: min={rawMin:F6} max={rawMax:F6} mean={rawSum/rawMask.Length:F6} range={rawMax-rawMin:F6}");

                    bool minMaxSkipped = (rawMax - rawMin) < 1e-6f;
                    MinMaxNormalize(rawMask);

                    float normMax = 0f;
                    foreach (var v in rawMask) if (v > normMax) normMax = v;
                    Console.Error.WriteLine(
                        $"[BGEngine] after MinMaxNorm: max={normMax:F4} (skipped={minMaxSkipped})");
                    Console.Error.Flush();

                    var resized = ResizeMask(rawMask, modelSize, modelSize, origW, origH);
                    alphaMask   = ApplyDualThreshold(resized, lower, upper);
                }
            }
            catch (OutOfMemoryException)
            {
                throw new InvalidOperationException(
                    $"メモリ不足: マスクバッファの確保に失敗しました（画像サイズ: {origW}×{origH}）。画像を縮小してから再試行してください。");
            }

            await SaveRgbaPng(image, alphaMask, origW, origH, outputPath);
        }
        finally
        {
            image?.Dispose();
        }
    }

    // ── Private: Preprocess ─────────────────────────────────────

    /// <summary>isnetis 用: ÷255 のみ、1024×1024</summary>
    private static float[] PrepareInputIsnet(Image<Rgb24> image)
    {
        using var resized = image.Clone(ctx => ctx.Resize(ISNET_SIZE, ISNET_SIZE));
        int n      = ISNET_SIZE * ISNET_SIZE;
        var tensor = new float[3 * n];
        resized.ProcessPixelRows(acc =>
        {
            for (int y = 0; y < ISNET_SIZE; y++)
            {
                var row = acc.GetRowSpan(y);
                for (int x = 0; x < ISNET_SIZE; x++)
                {
                    var p   = row[x];
                    int idx = y * ISNET_SIZE + x;
                    tensor[0 * n + idx] = p.R / 255f;
                    tensor[1 * n + idx] = p.G / 255f;
                    tensor[2 * n + idx] = p.B / 255f;
                }
            }
        });
        return tensor;
    }

    /// <summary>U2-Net 用: ImageNet 正規化、320×320</summary>
    private static float[] PrepareInputU2Net(Image<Rgb24> image)
    {
        using var resized = image.Clone(ctx => ctx.Resize(U2NET_SIZE, U2NET_SIZE));
        int n      = U2NET_SIZE * U2NET_SIZE;
        var tensor = new float[3 * n];
        resized.ProcessPixelRows(acc =>
        {
            for (int y = 0; y < U2NET_SIZE; y++)
            {
                var row = acc.GetRowSpan(y);
                for (int x = 0; x < U2NET_SIZE; x++)
                {
                    var p   = row[x];
                    int idx = y * U2NET_SIZE + x;
                    tensor[0 * n + idx] = (p.R / 255f - U2NET_MEAN[0]) / U2NET_STD[0];
                    tensor[1 * n + idx] = (p.G / 255f - U2NET_MEAN[1]) / U2NET_STD[1];
                    tensor[2 * n + idx] = (p.B / 255f - U2NET_MEAN[2]) / U2NET_STD[2];
                }
            }
        });
        return tensor;
    }

    // ── Private: Inference ──────────────────────────────────────

    private static float[] RunInference(float[] tensor, int size, InferenceSession session)
    {
        string inName = session.InputMetadata.Keys.First();
        var input  = new DenseTensor<float>(tensor, [1, 3, size, size]);
        var inputs = new[] { NamedOnnxValue.CreateFromTensor(inName, input) };
        using var results = session.Run(inputs);
        return results.First().AsTensor<float>().ToArray();
    }

    private InferenceSession GetOrCreateIsnet()
    {
        lock (_lock) { _isnetSession ??= CreateSession(_isnetPath); return _isnetSession; }
    }

    private InferenceSession GetOrCreateU2Net()
    {
        lock (_lock) { _u2netSession ??= CreateSession(_u2netPath); return _u2netSession; }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _isnetSession?.Dispose(); _isnetSession = null;
            _u2netSession?.Dispose(); _u2netSession = null;
        }
    }

    private static InferenceSession CreateSession(string modelPath)
    {
        var opts = new SessionOptions
        {
            GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL,
            ExecutionMode          = ExecutionMode.ORT_PARALLEL,
        };
        try { opts.AppendExecutionProvider_DML(deviceId: 0); } catch { }
        return new InferenceSession(modelPath, opts);
    }

    // ── Private: Post-process ───────────────────────────────────

    /// <summary>Min-Max 正規化: 弱い信号でも [0,1] に引き伸ばす。</summary>
    private static void MinMaxNormalize(float[] arr)
    {
        float min = float.MaxValue, max = float.MinValue;
        foreach (var v in arr) { if (v < min) min = v; if (v > max) max = v; }
        float range = max - min;
        if (range < 1e-6f) return;
        for (int i = 0; i < arr.Length; i++) arr[i] = (arr[i] - min) / range;
    }

    /// <summary>
    /// Dual Threshold によるアルファ再マッピング（unsafe ポインタ、O(N)、整数演算のみ）。
    ///   A &lt;= lower → 0
    ///   A >= upper → 255
    ///   中間域     → (A - lower) * 255 / range
    /// </summary>
    private static unsafe byte[] ApplyDualThreshold(float[] mask, int lower, int upper)
    {
        int len   = mask.Length;
        var alpha = new byte[len];
        int range = upper - lower;

        fixed (float* src = mask)
        fixed (byte*  dst = alpha)
        {
            for (int i = 0; i < len; i++)
            {
                int a = (int)(src[i] * 255f);
                if (a <= lower)
                    dst[i] = 0;
                else if (a >= upper)
                    dst[i] = 255;
                else
                {
                    int val = (a - lower) * 255 / range;
                    if (val < 0)   val = 0;
                    if (val > 255) val = 255;
                    dst[i] = (byte)val;
                }
            }
        }
        return alpha;
    }

    private static float[] ResizeMask(float[] mask, int srcW, int srcH, int dstW, int dstH)
    {
        var result = new float[dstW * dstH];
        float sx = (float)srcW / dstW, sy = (float)srcH / dstH;
        for (int y = 0; y < dstH; y++)
        {
            float fy0s = (y + 0.5f) * sy - 0.5f;
            int y0 = Math.Clamp((int)fy0s, 0, srcH - 1), y1 = Math.Clamp(y0 + 1, 0, srcH - 1);
            float fy = fy0s - y0;
            for (int x = 0; x < dstW; x++)
            {
                float fx0s = (x + 0.5f) * sx - 0.5f;
                int x0 = Math.Clamp((int)fx0s, 0, srcW - 1), x1 = Math.Clamp(x0 + 1, 0, srcW - 1);
                float fx = fx0s - x0;
                result[y * dstW + x] =
                    mask[y0 * srcW + x0] * (1 - fx) * (1 - fy) +
                    mask[y0 * srcW + x1] * fx        * (1 - fy) +
                    mask[y1 * srcW + x0] * (1 - fx)  * fy       +
                    mask[y1 * srcW + x1] * fx         * fy;
            }
        }
        return result;
    }

    // ── Logo Mode: Color-Diff Background Removal ────────────────

    /// <summary>
    /// 色差ベースのロゴ背景除去。
    ///
    /// ニューラルネットワーク不要。ベタ塗り/グラデーション背景のテキスト・ロゴに最適。
    ///
    /// アルゴリズム:
    ///   1. 全4辺のエッジピクセルから背景色の平均・標準偏差をサンプリング
    ///      (四隅のみでは背景のグラデーション・テクスチャを捉えられないため)
    ///   2. 標準偏差に基づいて許容値を動的に調整 (tol = max(40, 2.5σ))
    ///   3. 各ピクセルと背景平均色の RGB ユークリッド距離を計算
    ///   4. 距離に応じてソフトエッジ付きアルファ値を生成
    /// </summary>
    private static byte[] ExtractLogoByColorDiff(Image<Rgb24> image, int w, int h)
    {
        // Step 1: 全エッジピクセルから背景色の平均・分散を計算
        // 四隅サンプルだと背景の色変動（テクスチャ、グラデーション）を見落とす
        float sumR = 0, sumG = 0, sumB = 0;
        float sumR2 = 0, sumG2 = 0, sumB2 = 0;
        int   cnt  = 0;

        image.ProcessPixelRows(acc =>
        {
            // 上端・下端の行全体
            var rowT = acc.GetRowSpan(0);
            var rowB = acc.GetRowSpan(h - 1);
            for (int x = 0; x < w; x++)
            {
                void AddH(Rgb24 p)
                {
                    sumR += p.R; sumG += p.G; sumB += p.B;
                    sumR2 += p.R * p.R; sumG2 += p.G * p.G; sumB2 += p.B * p.B;
                    cnt++;
                }
                AddH(rowT[x]); AddH(rowB[x]);
            }
            // 左端・右端（上下端を除く）
            for (int y = 1; y < h - 1; y++)
            {
                var row = acc.GetRowSpan(y);
                void AddV(Rgb24 p)
                {
                    sumR += p.R; sumG += p.G; sumB += p.B;
                    sumR2 += p.R * p.R; sumG2 += p.G * p.G; sumB2 += p.B * p.B;
                    cnt++;
                }
                AddV(row[0]); AddV(row[w - 1]);
            }
        });

        float bgR = sumR / cnt, bgG = sumG / cnt, bgB = sumB / cnt;
        float stdR = MathF.Sqrt(MathF.Max(0, sumR2 / cnt - bgR * bgR));
        float stdG = MathF.Sqrt(MathF.Max(0, sumG2 / cnt - bgG * bgG));
        float stdB = MathF.Sqrt(MathF.Max(0, sumB2 / cnt - bgB * bgB));
        float maxStd = MathF.Max(stdR, MathF.Max(stdG, stdB));

        // 背景の色ばらつき (σ) に応じて許容値を動的に調整
        // 均一背景: tol≈40、テクスチャ背景: tol は 2.5σ まで伸長
        float tol       = MathF.Max(40f, maxStd * 2.5f);
        float fadeRange = tol * 0.4f;

        Console.Error.WriteLine(
            $"[LogoColor] bg mean: R={bgR:F0} G={bgG:F0} B={bgB:F0}  " +
            $"std: R={stdR:F1} G={stdG:F1} B={stdB:F1}  " +
            $"tol={tol:F1} fade={fadeRange:F1}  samples={cnt}");

        // Step 2: RGB ユークリッド距離でアルファマスクを生成
        var mask = new byte[w * h];
        image.ProcessPixelRows(acc =>
        {
            for (int y = 0; y < h; y++)
            {
                var row = acc.GetRowSpan(y);
                for (int x = 0; x < w; x++)
                {
                    var   p    = row[x];
                    float dr   = p.R - bgR, dg = p.G - bgG, db = p.B - bgB;
                    float dist = MathF.Sqrt(dr * dr + dg * dg + db * db);
                    float a    = (dist - tol) / fadeRange;
                    mask[y * w + x] = (byte)Math.Clamp((int)(a * 255f), 0, 255);
                }
            }
        });

        int nonZero = 0; foreach (var v in mask) if (v > 0) nonZero++;
        Console.Error.WriteLine(
            $"[LogoColor] raw mask: nonzero={nonZero * 100.0 / mask.Length:F1}%");

        return mask;
    }

    // ── Logo Mode Post-Processing ────────────────────────────────

    /// <summary>
    /// ロゴモード専用後処理パイプライン。
    ///
    /// gentle=false: Otsu → MorphClose → IslandFilter → FringeErosion → GaussianBlur → ContrastStretch
    /// gentle=true:  Otsu → IslandFilter → GaussianBlur → ContrastStretch
    ///   ※ ColorDiff 出力はソフトエッジなので Erosion/MorphClose は不要
    /// </summary>
    private static byte[] RefineLogoMask(byte[] alpha, int w, int h, bool gentle = false)
    {
        Console.Error.WriteLine($"[LogoRefine] mode={( gentle ? "gentle" : "full" )}");

        // Step 1: Otsu の自動閾値 + 単峰性トラップへの安全フォールバック
        byte otsu    = OtsuThreshold(alpha);
        bool trapped = otsu < 10 || otsu > 200;
        byte thresh;
        if (trapped)
        {
            thresh = PercentileThreshold(alpha, keepTopPercent: 20);
            Console.Error.WriteLine(
                $"[LogoRefine] ⚠ Otsu={otsu} は極端値 (Unimodal Trap) → パーセンタイル閾値={thresh} (top 20%) にフォールバック");
        }
        else
        {
            thresh = otsu;
            Console.Error.WriteLine($"[LogoRefine] Otsu threshold={thresh} (正常)");
        }

        var mask = new byte[alpha.Length];
        for (int i = 0; i < alpha.Length; i++)
            mask[i] = alpha[i] >= thresh ? (byte)255 : (byte)0;
        LogMaskStats(mask, "after threshold");

        if (!gentle)
        {
            // Step 2 (full only): Morphological Close — fill holes in text glyphs (3×3)
            mask = MorphDilate(mask, w, h, radius: 1);
            mask = MorphErode(mask, w, h, radius: 1);
            LogMaskStats(mask, "after morph-close");
        }

        // Step 3: Remove only extreme noise; minArea=10 keeps fragmented letter pieces
        mask = RemoveSmallIslands(mask, w, h, minArea: 10);
        LogMaskStats(mask, "after island-filter");

        if (!gentle)
        {
            // Step 4 (full only): Fringe erosion (1px) to cut background color bleed
            mask = MorphErode(mask, w, h, radius: 1);
            LogMaskStats(mask, "after fringe-erosion");
        }

        // Step 5: Gaussian blur for AA edges (no re-threshold — use as alpha directly)
        var blurred = GaussianBlurMask(mask, w, h, sigma: 1.0f);

        // Step 6: Contrast stretch — amplify near-edge gradients for crisp AA
        var stretched = ContrastStretch(blurred);

        // Step 7: Alpha Crisping — sigmoid curve pushes mid-values toward 0/255
        //   gentle=true (ColorDiff): strength=5 (色差は既にシャープ寄りなので控えめ)
        //   gentle=false (full):     strength=7 (モルフォロジー後はよりクリスプに)
        Console.Error.Flush();
        return AlphaCrisp(stretched, strength: gentle ? 5f : 7f);
    }

    private static void LogMaskStats(byte[] mask, string label)
    {
        int white = 0;
        foreach (var v in mask) if (v > 0) white++;
        Console.Error.WriteLine($"[LogoRefine]   {label}: {white*100.0/mask.Length:F2}% white ({white}/{mask.Length} px)");
    }

    /// <summary>
    /// パーセンタイル閾値: 上位 keepTopPercent% のピクセルが残る閾値を返す。
    /// Otsu の単峰性トラップへのフォールバックとして使用。
    /// </summary>
    private static byte PercentileThreshold(byte[] alpha, int keepTopPercent)
    {
        var hist = new int[256];
        foreach (var v in alpha) hist[v]++;
        int targetCount = (int)(alpha.Length * keepTopPercent / 100.0);
        int accumulated = 0;
        for (int t = 255; t >= 0; t--)
        {
            accumulated += hist[t];
            if (accumulated >= targetCount) return (byte)t;
        }
        return 0;
    }

    /// <summary>大津の二値化 (Otsu's method): 最大クラス間分散を与える閾値を返す。</summary>
    private static byte OtsuThreshold(byte[] alpha)
    {
        var hist  = new int[256];
        foreach (var v in alpha) hist[v]++;
        int total = alpha.Length;

        double sum = 0;
        for (int i = 0; i < 256; i++) sum += i * hist[i];

        double sumB = 0;
        int    wB   = 0;
        double maxVar = 0;
        byte   best  = 128;

        for (int t = 0; t < 256; t++)
        {
            wB += hist[t];
            if (wB == 0) continue;
            int wF = total - wB;
            if (wF == 0) break;

            sumB += t * hist[t];
            double mB  = sumB / wB;
            double mF  = (sum - sumB) / wF;
            double var = (double)wB * wF * (mB - mF) * (mB - mF);

            if (var > maxVar) { maxVar = var; best = (byte)t; }
        }
        return best;
    }

    /// <summary>
    /// Alpha Crisping: 正規化シグモイドカーブで中間アルファ値を 0/255 両極に押し寄せる。
    ///
    /// 正規化により端点を厳密に保証:
    ///   alpha=0   → 0     (完全透明はそのまま — 背景にうっすら残らない)
    ///   alpha=255 → 255   (完全不透明はそのまま — 文字が薄くならない)
    ///   alpha=128 → 128   (中点は不変)
    ///
    /// 旧実装は f(0) ≈ 19, f(255) ≈ 235 となり白い背景がうっすら残る問題があった。
    /// 正規化式: norm = (sigmoid(s*(x-0.5)) - sigmoid(-s/2)) / (sigmoid(s/2) - sigmoid(-s/2))
    /// </summary>
    private static byte[] AlphaCrisp(byte[] src, float strength = 6f)
    {
        // 端点での sigmoid 値を事前計算して正規化係数を求める
        float lo    = 1f / (1f + MathF.Exp( strength * 0.5f));  // sigmoid(-s/2) ≡ x=0 のとき
        float hi    = 1f / (1f + MathF.Exp(-strength * 0.5f));  // sigmoid(+s/2) ≡ x=1 のとき
        float range = hi - lo;                                    // 正規化幅

        var result = new byte[src.Length];
        for (int i = 0; i < src.Length; i++)
        {
            float t       = src[i] / 255f - 0.5f;
            float sigmoid = 1f / (1f + MathF.Exp(-strength * t));
            float norm    = (sigmoid - lo) / range;              // [0, 1] に正規化
            result[i] = (byte)Math.Clamp((int)(norm * 255f + 0.5f), 0, 255);
        }
        return result;
    }

    /// <summary>コントラストストレッチ: min→0, max→255 に線形変換してエッジをシャープ化。</summary>
    private static byte[] ContrastStretch(byte[] src)
    {
        byte min = 255, max = 0;
        foreach (var v in src) { if (v < min) min = v; if (v > max) max = v; }
        if (max == min) return src;
        var   result = new byte[src.Length];
        float range  = max - min;
        for (int i = 0; i < src.Length; i++)
            result[i] = (byte)Math.Clamp((int)((src[i] - min) * 255f / range), 0, 255);
        return result;
    }

    private static byte[] MorphDilate(byte[] mask, int w, int h, int radius)
    {
        var result = new byte[mask.Length];
        for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
        {
            byte max = 0;
            for (int ky = -radius; ky <= radius && max < 255; ky++)
            for (int kx = -radius; kx <= radius; kx++)
            {
                int ny = Math.Clamp(y + ky, 0, h - 1);
                int nx = Math.Clamp(x + kx, 0, w - 1);
                if (mask[ny * w + nx] > max) max = mask[ny * w + nx];
            }
            result[y * w + x] = max;
        }
        return result;
    }

    private static byte[] MorphErode(byte[] mask, int w, int h, int radius)
    {
        var result = new byte[mask.Length];
        for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
        {
            byte min = 255;
            for (int ky = -radius; ky <= radius && min > 0; ky++)
            for (int kx = -radius; kx <= radius; kx++)
            {
                int ny = Math.Clamp(y + ky, 0, h - 1);
                int nx = Math.Clamp(x + kx, 0, w - 1);
                if (mask[ny * w + nx] < min) min = mask[ny * w + nx];
            }
            result[y * w + x] = min;
        }
        return result;
    }

    /// <summary>BFS でラベリングし、minArea 未満の孤立島を除去する。</summary>
    private static byte[] RemoveSmallIslands(byte[] mask, int w, int h, int minArea)
    {
        var labels  = new int[mask.Length];
        var result  = new byte[mask.Length];
        // ラベルIDは1始まりの連番 → List でO(1)アクセス (index = labelId)
        var areas   = new List<int> { 0 };  // index 0 は番兵
        var queue   = new Queue<int>();
        int labelId = 0;

        for (int i = 0; i < mask.Length; i++)
        {
            if (mask[i] != 255 || labels[i] != 0) continue;

            labelId++;
            int area = 0;
            labels[i] = labelId;
            queue.Enqueue(i);

            while (queue.Count > 0)
            {
                int idx = queue.Dequeue();
                area++;
                int cy = idx / w, cx = idx % w;
                if (cy > 0   && mask[idx - w] == 255 && labels[idx - w] == 0) { labels[idx - w] = labelId; queue.Enqueue(idx - w); }
                if (cy < h-1 && mask[idx + w] == 255 && labels[idx + w] == 0) { labels[idx + w] = labelId; queue.Enqueue(idx + w); }
                if (cx > 0   && mask[idx - 1] == 255 && labels[idx - 1] == 0) { labels[idx - 1] = labelId; queue.Enqueue(idx - 1); }
                if (cx < w-1 && mask[idx + 1] == 255 && labels[idx + 1] == 0) { labels[idx + 1] = labelId; queue.Enqueue(idx + 1); }
            }
            areas.Add(area);
        }

        for (int i = 0; i < mask.Length; i++)
            if (labels[i] > 0 && areas[labels[i]] >= minArea)
                result[i] = 255;

        return result;
    }

    /// <summary>分離可能 1D Gaussian Blur (sigma≈1 → 7タップカーネル)。</summary>
    private static byte[] GaussianBlurMask(byte[] mask, int w, int h, float sigma)
    {
        int radius = Math.Max(1, (int)MathF.Ceiling(sigma * 3));
        int ksize  = 2 * radius + 1;
        var kernel = new float[ksize];
        float ksum = 0;
        for (int i = 0; i < ksize; i++)
        {
            int dx = i - radius;
            kernel[i] = MathF.Exp(-dx * dx / (2 * sigma * sigma));
            ksum += kernel[i];
        }
        for (int i = 0; i < ksize; i++) kernel[i] /= ksum;

        // Horizontal pass
        var temp = new float[mask.Length];
        for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
        {
            float val = 0;
            for (int k = -radius; k <= radius; k++)
                val += mask[y * w + Math.Clamp(x + k, 0, w - 1)] * kernel[k + radius];
            temp[y * w + x] = val;
        }

        // Vertical pass
        var result = new byte[mask.Length];
        for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
        {
            float val = 0;
            for (int k = -radius; k <= radius; k++)
                val += temp[Math.Clamp(y + k, 0, h - 1) * w + x] * kernel[k + radius];
            result[y * w + x] = (byte)Math.Clamp((int)val, 0, 255);
        }
        return result;
    }

    /// <summary>診断用: byte[] alpha をグレースケール PNG として保存する（仮説2検証）。</summary>
    private static async Task SaveGrayscalePng(byte[] alpha, int w, int h, string path)
    {
        using var img = new Image<L8>(w, h);
        img.ProcessPixelRows(acc =>
        {
            for (int y = 0; y < h; y++)
            {
                var row = acc.GetRowSpan(y);
                for (int x = 0; x < w; x++)
                    row[x] = new L8(alpha[y * w + x]);
            }
        });
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await img.SaveAsPngAsync(path);
    }

    private static async Task SaveRgbaPng(
        Image<Rgb24> source, byte[] alphaMask, int w, int h, string outputPath)
    {
        using var rgba = new Image<Rgba32>(w, h);
        source.ProcessPixelRows(rgba, (srcAcc, dstAcc) =>
        {
            for (int y = 0; y < h; y++)
            {
                var srcRow = srcAcc.GetRowSpan(y);
                var dstRow = dstAcc.GetRowSpan(y);
                int rowBase = y * w;
                for (int x = 0; x < w; x++)
                {
                    var s = srcRow[x];
                    dstRow[x] = new Rgba32(s.R, s.G, s.B, alphaMask[rowBase + x]);
                }
            }
        });
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        await rgba.SaveAsPngAsync(outputPath);
    }
}
