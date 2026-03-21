using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using System.Runtime.InteropServices;

namespace QSAIWorker;

/// <summary>
/// シャープ境界 + キャンバス拡張 + AA 付き白枠ステッカー生成エンジン。
///
/// [OPTIMIZED] Parallel.For (全 Y ループ並列化) + unsafe GCHandle ポインタ
///
/// Pipeline:
///   0. ProcessPixelRows で元ピクセルを Rgba32[] に安全にコピー
///   1. PAD px 分キャンバスを拡張した byte[] alphaBuffer を作成（Parallel.For）
///   2. Morphological Dilation（スライディング最大値 H→V、各 Parallel.For）
///   3. Gaussian Blur（分離可能 H→V、各 Parallel.For）でエッジのジャギーを平滑化
///   4. 2値化 + 狭い AA バンド + Over 合成 → Rgba32[] outPixels（Parallel.For）
///   5. ProcessPixelRows で outPixels を出力画像に安全に書き戻す
///
/// スレッドセーフ戦略:
///   - 各 Parallel.For 行は互いに独立した行を読み書きするため競合なし
///   - 入力バッファ（読み込み専用）と出力バッファ（書き込み専用）を完全分離
///   - GCHandle.Alloc(Pinned) で GC によるオブジェクト移動を防ぎ、
///     nint (IntPtr) でポインタ値を lambda にキャプチャ可能にする
/// </summary>
public static class WhiteBorderEngine
{
    // ── パラメータ ──────────────────────────────────────────────────────
    private const int   DILATE_RADIUS = 3;    // 膨張半径 px
    private const float GAUSS_SIGMA   = 2.0f; // ガウスぼかし σ
    private const int   SHARP_THRESH  = 100;  // 2値化しきい値
    private const int   AA_BAND       = 40;   // AA 遷移帯幅

    private static int ComputePad() => DILATE_RADIUS + (int)(GAUSS_SIGMA * 3f) + 2;

    // ── Public Entry Point ─────────────────────────────────────────────
    /// <param name="origImagePath">
    /// 元絵モード用オリジナル画像パス。指定時は Parallel.For でエッジカラーを
    /// 自動サンプリングし、borderR/G/B を上書きする。
    /// </param>
    public static async Task AddWhiteBorderAsync(
        string inputPath, string outputPath, string? origImagePath = null,
        byte borderR = 255, byte borderG = 255, byte borderB = 255)
    {
        using var img = await Image.LoadAsync<Rgba32>(inputPath);
        int w = img.Width, h = img.Height, n = w * h;

        // ── Step 0: ProcessPixelRows で元ピクセルを Rgba32[] に安全にコピー ──
        var origPixels = new Rgba32[n];
        img.ProcessPixelRows(accessor =>
        {
            for (int y = 0; y < h; y++)
            {
                var row = accessor.GetRowSpan(y);
                row.CopyTo(origPixels.AsSpan(y * w, w));
            }
        });

        // ── 元絵モード: オリジナル画像からエッジカラーを Parallel.For でサンプリング ──
        if (!string.IsNullOrEmpty(origImagePath) && File.Exists(origImagePath))
        {
            using var origImg = await Image.LoadAsync<Rgba32>(origImagePath);
            int ow = origImg.Width, oh = origImg.Height;
            var origPix = new Rgba32[ow * oh];
            origImg.ProcessPixelRows(accessor =>
            {
                for (int y = 0; y < oh; y++)
                {
                    var row = accessor.GetRowSpan(y);
                    row.CopyTo(origPix.AsSpan(y * ow, ow));
                }
            });
            (borderR, borderG, borderB) = SampleEdgeColor(origPixels, origPix, w, h, ow, oh);
        }

        // ── Step 1: PAD 付きアルファバッファ（Parallel.For）──────────────
        int pad = ComputePad();
        int pw  = w + pad * 2;
        int ph  = h + pad * 2;
        int pn  = pw * ph;

        byte[] paddedAlpha = new byte[pn]; // zero-initialized → 外縁は透明
        CopyAlphaWithPad(origPixels, paddedAlpha, w, h, pw, pad);

        // ── Step 2: Morphological Dilation (H → V、各 Parallel.For) ─────
        byte[] dilTmp  = new byte[pn];
        byte[] dilated = new byte[pn];
        SlidingMaxH(paddedAlpha, dilTmp,  pw, ph, DILATE_RADIUS);
        SlidingMaxV(dilTmp,      dilated, pw, ph, DILATE_RADIUS);

        // ── Step 3: Gaussian Blur (Separable H → V、各 Parallel.For) ─────
        int     kRadius = (int)(GAUSS_SIGMA * 3f + 0.5f);
        float[] kernel  = BuildGaussKernel(GAUSS_SIGMA, kRadius);
        float[] blurTmp = new float[pn];
        float[] blurred = new float[pn];
        GaussH(dilated, blurTmp, pw, ph, kernel, kRadius);
        GaussV(blurTmp, blurred, pw, ph, kernel, kRadius);

        // ── Step 4: 2値化+AA + Over 合成 → flat Rgba32[]（Parallel.For）──
        var outPixels = new Rgba32[pn]; // zero-initialized → 完全透明
        Composite(origPixels, blurred, outPixels, w, h, pw, ph, pad, borderR, borderG, borderB);

        // ── Step 5: ProcessPixelRows で outPixels を出力画像に安全に書き戻す ─
        using var outImg = new Image<Rgba32>(pw, ph);
        outImg.ProcessPixelRows(accessor =>
        {
            for (int y = 0; y < ph; y++)
            {
                var row = accessor.GetRowSpan(y);
                outPixels.AsSpan(y * pw, pw).CopyTo(row);
            }
        });

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        await outImg.SaveAsPngAsync(outputPath);
    }

    // ── Step 1: アルファ抽出 + パディング（Parallel.For on Y）────────────
    // 各行は独立 → 読み込み: origPixels[y*w .. +w]、書き込み: paddedAlpha[(y+pad)*pw+pad .. +w]
    private static unsafe void CopyAlphaWithPad(
        Rgba32[] origPixels, byte[] paddedAlpha, int w, int h, int pw, int pad)
    {
        var hOrig = GCHandle.Alloc(origPixels, GCHandleType.Pinned);
        var hPa   = GCHandle.Alloc(paddedAlpha, GCHandleType.Pinned);
        try
        {
            nint pOrig = (nint)hOrig.AddrOfPinnedObject();
            nint pPa   = (nint)hPa.AddrOfPinnedObject();
            Parallel.For(0, h, y =>
            {
                Rgba32* srcRow = (Rgba32*)pOrig + y * w;
                byte*   dstRow = (byte*)pPa + (y + pad) * pw + pad;
                for (int x = 0; x < w; x++)
                    dstRow[x] = srcRow[x].A;
            });
        }
        finally
        {
            hOrig.Free();
            hPa.Free();
        }
    }

    // ── Horizontal Sliding Maximum（Parallel.For on Y）──────────────────
    // 各行は完全独立: rs = src[y*w..], rd = dst[y*w..] が他行と重ならない
    private static unsafe void SlidingMaxH(byte[] src, byte[] dst, int w, int h, int r)
    {
        var hSrc = GCHandle.Alloc(src, GCHandleType.Pinned);
        var hDst = GCHandle.Alloc(dst, GCHandleType.Pinned);
        try
        {
            nint pS = (nint)hSrc.AddrOfPinnedObject();
            nint pD = (nint)hDst.AddrOfPinnedObject();
            Parallel.For(0, h, y =>
            {
                byte* rs = (byte*)pS + y * w;
                byte* rd = (byte*)pD + y * w;
                for (int x = 0; x < w; x++)
                {
                    int  x0 = x - r < 0  ? 0     : x - r;
                    int  x1 = x + r >= w ? w - 1 : x + r;
                    byte mx = 0;
                    for (int xi = x0; xi <= x1; xi++)
                        if (rs[xi] > mx) mx = rs[xi];
                    rd[x] = mx;
                }
            });
        }
        finally
        {
            hSrc.Free();
            hDst.Free();
        }
    }

    // ── Vertical Sliding Maximum（Parallel.For on Y、行優先に変更）────────
    // 旧: for x { for y } → 列優先、キャッシュミス多発
    // 新: Parallel.For(y) { for x } → 行優先+並列、書き込み行 y は他スレッドと重ならない
    // 読み込み: src[(y0..y1)*w + x]（複数行参照だが読み込み専用 → 競合なし）
    // 書き込み: dst[y*w .. y*w+w]（各スレッドが異なる行を書く → 競合なし）
    private static unsafe void SlidingMaxV(byte[] src, byte[] dst, int w, int h, int r)
    {
        var hSrc = GCHandle.Alloc(src, GCHandleType.Pinned);
        var hDst = GCHandle.Alloc(dst, GCHandleType.Pinned);
        try
        {
            nint pS = (nint)hSrc.AddrOfPinnedObject();
            nint pD = (nint)hDst.AddrOfPinnedObject();
            Parallel.For(0, h, y =>
            {
                int   y0 = y - r < 0  ? 0     : y - r;
                int   y1 = y + r >= h ? h - 1 : y + r;
                byte* ps = (byte*)pS;
                byte* rd = (byte*)pD + y * w;
                for (int x = 0; x < w; x++)
                {
                    byte mx = 0;
                    for (int yi = y0; yi <= y1; yi++)
                    {
                        byte v = ps[yi * w + x];
                        if (v > mx) mx = v;
                    }
                    rd[x] = mx;
                }
            });
        }
        finally
        {
            hSrc.Free();
            hDst.Free();
        }
    }

    // ── Gaussian Kernel 生成 ───────────────────────────────────────────
    private static float[] BuildGaussKernel(float sigma, int r)
    {
        int   len    = 2 * r + 1;
        var   k      = new float[len];
        float inv2s2 = 1f / (2f * sigma * sigma);
        float sum    = 0f;
        for (int i = 0; i < len; i++)
        {
            float x = i - r;
            k[i] = MathF.Exp(-x * x * inv2s2);
            sum += k[i];
        }
        for (int i = 0; i < len; i++) k[i] /= sum;
        return k;
    }

    // ── Gaussian Horizontal  byte[] → float[]（Parallel.For on Y）────────
    // 分離型フィルタ: X 方向のみの 1D ブラー
    // 各行は独立: srow = src[y*w..], drow = dst[y*w..] が他行と重ならない
    private static unsafe void GaussH(byte[] src, float[] dst, int w, int h, float[] k, int r)
    {
        var hSrc = GCHandle.Alloc(src, GCHandleType.Pinned);
        var hDst = GCHandle.Alloc(dst, GCHandleType.Pinned);
        var hK   = GCHandle.Alloc(k,   GCHandleType.Pinned);
        try
        {
            nint pS  = (nint)hSrc.AddrOfPinnedObject();
            nint pD  = (nint)hDst.AddrOfPinnedObject();
            nint pKp = (nint)hK.AddrOfPinnedObject();
            Parallel.For(0, h, y =>
            {
                int    yw   = y * w;
                byte*  srow = (byte*)pS  + yw;
                float* drow = (float*)pD + yw;
                float* kp   = (float*)pKp;
                for (int x = 0; x < w; x++)
                {
                    float acc = 0f;
                    for (int ki = -r; ki <= r; ki++)
                    {
                        int xi = x + ki;
                        if (xi < 0) xi = 0; else if (xi >= w) xi = w - 1;
                        acc += srow[xi] * kp[ki + r];
                    }
                    drow[x] = acc;
                }
            });
        }
        finally
        {
            hSrc.Free();
            hDst.Free();
            hK.Free();
        }
    }

    // ── Gaussian Vertical  float[] → float[]（Parallel.For on Y）─────────
    // 分離型フィルタ: Y 方向のみの 1D ブラー
    // 読み込み: src[(y±r)*w + x]（読み込み専用 → 競合なし）
    // 書き込み: dst[y*w .. y*w+w]（各スレッドが異なる行を書く → 競合なし）
    private static unsafe void GaussV(float[] src, float[] dst, int w, int h, float[] k, int r)
    {
        var hSrc = GCHandle.Alloc(src, GCHandleType.Pinned);
        var hDst = GCHandle.Alloc(dst, GCHandleType.Pinned);
        var hK   = GCHandle.Alloc(k,   GCHandleType.Pinned);
        try
        {
            nint pS  = (nint)hSrc.AddrOfPinnedObject();
            nint pD  = (nint)hDst.AddrOfPinnedObject();
            nint pKp = (nint)hK.AddrOfPinnedObject();
            Parallel.For(0, h, y =>
            {
                int    yw   = y * w;
                float* drow = (float*)pD + yw;
                float* ps   = (float*)pS;
                float* kp   = (float*)pKp;
                for (int x = 0; x < w; x++)
                {
                    float acc = 0f;
                    for (int ki = -r; ki <= r; ki++)
                    {
                        int yi = y + ki;
                        if (yi < 0) yi = 0; else if (yi >= h) yi = h - 1;
                        acc += ps[yi * w + x] * kp[ki + r];
                    }
                    drow[x] = acc;
                }
            });
        }
        finally
        {
            hSrc.Free();
            hDst.Free();
            hK.Free();
        }
    }

    // ── 元絵モード: エッジカラーサンプリング（Parallel.For on Y）─────────────
    // currentPix の透明ピクセルかつ隣接に不透明ピクセルがある位置 = 境界外縁
    // origPix の同座標（スケール補正済み）の RGB を平均してボーダー色を決定
    // スレッドローカル集計 → ロックは localFinally でのみ発生、ホットループは競合なし
    private static (byte r, byte g, byte b) SampleEdgeColor(
        Rgba32[] curPix, Rgba32[] origPix, int w, int h, int ow, int oh)
    {
        long[] totals = new long[4]; // [R, G, B, Count]
        object sync   = new();

        Parallel.For(0, h,
            () => new long[4],
            (y, _, local) =>
            {
                for (int x = 0; x < w; x++)
                {
                    if (curPix[y * w + x].A > 64) continue; // 不透明側はスキップ

                    // 4近傍に不透明ピクセルがあるか（境界外縁の判定）
                    bool hasOpaque =
                        (x > 0   && curPix[y * w + x - 1].A > 64) ||
                        (x < w-1 && curPix[y * w + x + 1].A > 64) ||
                        (y > 0   && curPix[(y-1) * w + x].A > 64) ||
                        (y < h-1 && curPix[(y+1) * w + x].A > 64);
                    if (!hasOpaque) continue;

                    // オリジナル画像の対応座標（スケール補正）
                    int ox = (int)Math.Round(x * (double)ow / w);
                    int oy = (int)Math.Round(y * (double)oh / h);
                    if (ox >= ow) ox = ow - 1;
                    if (oy >= oh) oy = oh - 1;

                    var op = origPix[oy * ow + ox];
                    local[0] += op.R; local[1] += op.G; local[2] += op.B; local[3]++;
                }
                return local;
            },
            local =>
            {
                lock (sync)
                {
                    totals[0] += local[0]; totals[1] += local[1];
                    totals[2] += local[2]; totals[3] += local[3];
                }
            });

        if (totals[3] == 0) return (255, 255, 255); // 境界が見つからない場合は白
        return (
            (byte)(totals[0] / totals[3]),
            (byte)(totals[1] / totals[3]),
            (byte)(totals[2] / totals[3]));
    }

    // ── Step 4: 2値化+AA + Over 合成（Parallel.For on Y）─────────────────
    // 各行 py は oprow = outPixels[py*pw..] にのみ書き込む → 行間で競合なし
    // origPixels は読み込み専用 → 競合なし
    private static unsafe void Composite(
        Rgba32[] origPixels, float[] blurred, Rgba32[] outPixels,
        int w, int h, int pw, int ph, int pad,
        byte borderR, byte borderG, byte borderB)
    {
        float aaLow      = SHARP_THRESH - AA_BAND;
        float aaInvRange = 255f / AA_BAND;

        var hOp   = GCHandle.Alloc(outPixels,  GCHandleType.Pinned);
        var hOrig = GCHandle.Alloc(origPixels, GCHandleType.Pinned);
        var hBl   = GCHandle.Alloc(blurred,    GCHandleType.Pinned);
        try
        {
            nint pOp   = (nint)hOp.AddrOfPinnedObject();
            nint pOrig = (nint)hOrig.AddrOfPinnedObject();
            nint pBl   = (nint)hBl.AddrOfPinnedObject();

            Parallel.For(0, ph, py =>
            {
                int     oy    = py - pad;
                int     pyw   = py * pw;
                Rgba32* oprow = (Rgba32*)pOp + pyw;
                float*  blrow = (float*)pBl  + pyw;

                for (int px2 = 0; px2 < pw; px2++)
                {
                    int   ox = px2 - pad;
                    float bv = blrow[px2];
                    int   ba;
                    if      (bv >= SHARP_THRESH) ba = 255;
                    else if (bv <= aaLow)        ba = 0;
                    else                          ba = (int)((bv - aaLow) * aaInvRange);

                    if (ba == 0) continue; // 枠外: zero-initialized のまま

                    int oa = 0, oR = 0, oG = 0, oB = 0;
                    if ((uint)ox < (uint)w && (uint)oy < (uint)h)
                    {
                        // uint キャスト: ox<0 の場合 uintMax になり条件が偽になる
                        Rgba32* srcPtr = (Rgba32*)pOrig + oy * w + ox;
                        oa = srcPtr->A; oR = srcPtr->R; oG = srcPtr->G; oB = srcPtr->B;
                    }

                    // Over 合成: 枠色(ba) UNDER 元画像(oa)
                    if (oa == 255)
                    {
                        oprow[px2] = new Rgba32((byte)oR, (byte)oG, (byte)oB, 255);
                        continue;
                    }

                    // bp = ba * (255-oa) / 255  (>>8 ≈ /255, 誤差 < 0.4%)
                    int bp    = ba * (255 - oa) >> 8;
                    int out_a = oa + bp;
                    if (out_a == 0) continue;

                    // out_RGB = (orig_RGB * oa + borderRGB * bp + round) / out_a
                    int half = out_a >> 1;
                    oprow[px2] = new Rgba32(
                        (byte)((oR * oa + borderR * bp + half) / out_a),
                        (byte)((oG * oa + borderG * bp + half) / out_a),
                        (byte)((oB * oa + borderB * bp + half) / out_a),
                        (byte)(out_a > 255 ? 255 : out_a));
                }
            });
        }
        finally
        {
            hOp.Free();
            hOrig.Free();
            hBl.Free();
        }
    }
}
