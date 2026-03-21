using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace QSAIWorker;

/// <summary>
/// Edge-Aware Strict Flood Fill による部分透過・復元エンジン。
///
/// Pipeline:
///   Step A: BFS Flood Fill (Edge-Aware Strict) → binary mask (0 or 255)
///           - 基点色との距離 d ≤ STRICT_TOLERANCE で伝播
///           - 隣接ピクセル間のローカルエッジ（現在→隣接の色差）が EDGE_THRESHOLD を
///             超える場合は強制ストップ（境界線をまたがない）
///   Step B: 5×5 Box Blur (H→V, separable) → ソフトエッジマスク (0–255)
///   Step C: アルファブレンド
///     Erase  : A = A * (255 - mask) / 255
///     Restore: lerp(current, original, mask/255)
///
/// 実装: unsafe ポインタのみ、GetPixel/SetPixel 不使用、O(N)
/// </summary>
public static class RefineEngine
{
    private const int BOX_RADIUS = 2; // 5×5 box blur → ±2px フェザリング帯

    // 基点色との最大色差（RGBユークリッド距離の2乗）
    // 12^2 = 144 → 厳格な選択、誤爆を防ぐ
    private const int STRICT_TOLERANCE = 12;
    private const int STRICT_TOL_SQ    = STRICT_TOLERANCE * STRICT_TOLERANCE;

    // 隣接ピクセル間のローカルエッジ閾値（2乗）
    // 25^2 = 625 → これを超えたら境界線とみなして強制ストップ
    private const int EDGE_THRESHOLD = 25;
    private const int EDGE_THRESH_SQ  = EDGE_THRESHOLD * EDGE_THRESHOLD;

    public static async Task RefineAsync(
        string originalPath, string currentPath,
        int x, int y, string mode,
        string outputPath)
    {
        using var original = await Image.LoadAsync<Rgba32>(originalPath);
        using var current  = await Image.LoadAsync<Rgba32>(currentPath);

        int w = current.Width, h = current.Height;
        x = Math.Clamp(x, 0, w - 1);
        y = Math.Clamp(y, 0, h - 1);

        // ── フラット配列に展開（BFS での O(1) ランダムアクセスのため）──
        var origData = new Rgba32[w * h];
        var currData = new Rgba32[w * h];

        original.ProcessPixelRows(acc =>
        {
            int rows = Math.Min(h, original.Height);
            for (int row = 0; row < rows; row++)
                acc.GetRowSpan(row).CopyTo(origData.AsSpan(row * w, w));
        });
        current.ProcessPixelRows(acc =>
        {
            for (int row = 0; row < h; row++)
                acc.GetRowSpan(row).CopyTo(currData.AsSpan(row * w, w));
        });

        // ── Step A: BFS → バイナリマスク (0 or 255) ──────────────────
        byte[] mask    = new byte[w * h]; // zero-initialized
        BFSMask(origData, currData, w, h, x, y, mode, mask);

        // ── Step B: 5×5 Box Blur → ソフトエッジマスク ────────────────
        byte[] blurred = new byte[w * h];
        BoxBlurSeparable(mask, blurred, w, h, BOX_RADIUS);

        // ── Step C: マスクを使ったアルファブレンド ────────────────────
        ApplyMask(origData, currData, blurred, w * h, mode == "erase");

        // ── PNG 書き出し ───────────────────────────────────────────────
        using var output = new Image<Rgba32>(w, h);
        output.ProcessPixelRows(acc =>
        {
            for (int row = 0; row < h; row++)
                currData.AsSpan(row * w, w).CopyTo(acc.GetRowSpan(row));
        });

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        await output.SaveAsPngAsync(outputPath);
    }

    // ── Step A: BFS Flood Fill (Edge-Aware Strict) → binary mask ───────

    private static unsafe void BFSMask(
        Rgba32[] origData, Rgba32[] currData,
        int w, int h, int startX, int startY,
        string mode, byte[] mask)
    {
        bool isErase  = mode == "erase";
        int  startIdx = startY * w + startX;

        // 開始ピクセルが既に処理済みなら何もしない
        if (isErase  && currData[startIdx].A == 0)   return;
        if (!isErase && currData[startIdx].A >= 128)  return;

        // ターゲット色: erase 時は original の色を参照（半透明加工後の色ずれに強い）
        Rgba32 target = origData[startIdx];

        var visited = new bool[w * h];
        var queue   = new Queue<int>(Math.Min(w * h, 1 << 16));
        queue.Enqueue(startIdx);
        visited[startIdx] = true;

        fixed (Rgba32* origPtr  = origData)
        fixed (Rgba32* currPtr  = currData)
        fixed (bool*   visitPtr = visited)
        fixed (byte*   maskPtr  = mask)
        {
            while (queue.Count > 0)
            {
                int idx = queue.Dequeue();
                int px  = idx % w;
                int py  = idx / w;

                maskPtr[idx] = 255; // 塗りつぶし領域としてマーク

                Rgba32 fromOrig = origPtr[idx]; // 現在ピクセルの元画像色（エッジ計算用）

                if (py > 0)     TryEnqueue(idx - w, isErase, origPtr, currPtr, visitPtr, queue, target, fromOrig, w, h);
                if (py < h - 1) TryEnqueue(idx + w, isErase, origPtr, currPtr, visitPtr, queue, target, fromOrig, w, h);
                if (px > 0)     TryEnqueue(idx - 1, isErase, origPtr, currPtr, visitPtr, queue, target, fromOrig, w, h);
                if (px < w - 1) TryEnqueue(idx + 1, isErase, origPtr, currPtr, visitPtr, queue, target, fromOrig, w, h);
            }
        }
    }

    /// <summary>
    /// 隣接ピクセルをキューに追加するか判定。
    /// 条件:
    ///   1. 未訪問
    ///   2. 透明/不透明の対象状態が合っている
    ///   3. 基点色との距離 ≤ STRICT_TOLERANCE (STRICT_TOL_SQ)
    ///   4. 現在ピクセル→隣接ピクセルのローカルエッジ ≤ EDGE_THRESHOLD (EDGE_THRESH_SQ)
    ///      この条件を超えたら強制ストップ（境界線・輪郭をまたがない）
    /// </summary>
    private static unsafe void TryEnqueue(
        int nIdx, bool isErase,
        Rgba32* origPtr, Rgba32* currPtr, bool* visitPtr,
        Queue<int> queue,
        Rgba32 target, Rgba32 fromOrig,
        int w, int h)
    {
        if (visitPtr[nIdx]) return;
        visitPtr[nIdx] = true;

        // 透明度フィルタ
        if (isErase  && currPtr[nIdx].A == 0)   return;
        if (!isErase && currPtr[nIdx].A >= 128)  return;

        Rgba32 neighOrig = origPtr[nIdx];

        // ── 条件3: 基点色との距離チェック（厳格な固定許容値）─────────
        int dr = neighOrig.R - target.R;
        int dg = neighOrig.G - target.G;
        int db = neighOrig.B - target.B;
        if (dr * dr + dg * dg + db * db > STRICT_TOL_SQ) return;

        // ── 条件4: ローカルエッジストップ（強制境界）─────────────────
        // 現在ピクセル(fromOrig) → 隣接ピクセル(neighOrig) 間の色差
        int er = neighOrig.R - fromOrig.R;
        int eg = neighOrig.G - fromOrig.G;
        int eb = neighOrig.B - fromOrig.B;
        if (er * er + eg * eg + eb * eb > EDGE_THRESH_SQ) return;

        queue.Enqueue(nIdx);
    }

    // ── Step B: 分離可能 Box Blur (H→V) ────────────────────────────────

    private static unsafe void BoxBlurSeparable(byte[] src, byte[] dst, int w, int h, int r)
    {
        float[] tmp = new float[w * h];

        // H パス: byte[] → float[]
        fixed (byte*  s = src)
        fixed (float* t = tmp)
        {
            for (int y = 0; y < h; y++)
            {
                int yw = y * w;
                for (int x = 0; x < w; x++)
                {
                    int   x0  = x - r < 0   ? 0     : x - r;
                    int   x1  = x + r >= w  ? w - 1 : x + r;
                    float sum = 0f;
                    for (int xi = x0; xi <= x1; xi++)
                        sum += s[yw + xi];
                    t[yw + x] = sum / (x1 - x0 + 1);
                }
            }
        }

        // V パス: float[] → byte[]
        fixed (float* t = tmp)
        fixed (byte*  d = dst)
        {
            for (int y = 0; y < h; y++)
            {
                int yw = y * w;
                for (int x = 0; x < w; x++)
                {
                    int   y0  = y - r < 0   ? 0     : y - r;
                    int   y1  = y + r >= h  ? h - 1 : y + r;
                    float sum = 0f;
                    for (int yi = y0; yi <= y1; yi++)
                        sum += t[yi * w + x];
                    float val = sum / (y1 - y0 + 1);
                    d[yw + x] = val >= 255f ? (byte)255 : (byte)val;
                }
            }
        }
    }

    // ── Step C: マスクを使ったアルファブレンド ──────────────────────────

    private static unsafe void ApplyMask(
        Rgba32[] origData, Rgba32[] currData,
        byte[] blurredMask, int n, bool isErase)
    {
        fixed (Rgba32* origPtr = origData, currPtr = currData)
        fixed (byte*   maskPtr = blurredMask)
        {
            for (int i = 0; i < n; i++)
            {
                int m = maskPtr[i];
                if (m == 0) continue;

                if (isErase)
                {
                    if (m == 255)
                        currPtr[i] = new Rgba32(currPtr[i].R, currPtr[i].G, currPtr[i].B, 0);
                    else
                    {
                        int a = currPtr[i].A * (255 - m) / 255;
                        currPtr[i] = new Rgba32(currPtr[i].R, currPtr[i].G, currPtr[i].B, (byte)a);
                    }
                }
                else
                {
                    if (m == 255)
                        currPtr[i] = origPtr[i];
                    else
                    {
                        Rgba32 cur = currPtr[i];
                        Rgba32 org = origPtr[i];
                        int    inv = 255 - m;
                        currPtr[i] = new Rgba32(
                            (byte)((cur.R * inv + org.R * m) / 255),
                            (byte)((cur.G * inv + org.G * m) / 255),
                            (byte)((cur.B * inv + org.B * m) / 255),
                            (byte)((cur.A * inv + org.A * m) / 255));
                    }
                }
            }
        }
    }
}
