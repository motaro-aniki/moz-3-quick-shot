using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace QSAIWorker;

/// <summary>
/// ImageSharp Lanczos3 + GaussianSharpen によるアップスケールエンジン。
/// モデル不要。背景透過済み（RGBA）画像に対応。
/// </summary>
public static class UpscaleEngine
{
    /// <summary>
    /// 入力画像を scale 倍にアップスケールして outputPath に保存する。
    /// </summary>
    /// <param name="inputPath">入力 PNG パス（RGBA 可）</param>
    /// <param name="outputPath">出力 PNG パス</param>
    /// <param name="scale">倍率（2 or 4）</param>
    public static async Task UpscaleAsync(string inputPath, string outputPath, int scale)
    {
        using var image = await Image.LoadAsync<Rgba32>(inputPath);

        int targetW = image.Width  * scale;
        int targetH = image.Height * scale;

        image.Mutate(ctx =>
        {
            ctx.Resize(new ResizeOptions
            {
                Size    = new Size(targetW, targetH),
                Sampler = KnownResamplers.Lanczos3,
                PremultiplyAlpha = true,
            });
            // アップスケール後の輪郭をシャープ化
            ctx.GaussianSharpen(1.2f);
        });

        await image.SaveAsPngAsync(outputPath);
    }
}
