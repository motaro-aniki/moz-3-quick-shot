using System.Text.Json;
using System.Text.Json.Serialization;

namespace QSAIWorker;

// ── JSON Protocol ──────────────────────────────────────────────
// 入力 (stdin, 改行区切りJSON):
//   {"id":"1","action":"ping"}
//   {"id":"2","action":"status"}
//   {"id":"3","action":"removebg","imagePath":"...","outputPath":"..."}
//   {"id":"4","action":"sr-upscale","imagePath":"...","outputPath":"...","scale":2}
// 出力 (stdout, 改行区切りJSON):
//   {"id":"1","pong":true}
//   {"id":"2","ready":true,"modelReady":true/false}
//   {"id":"3","success":true,"processingMs":320}
//   {"id":"x","success":false,"error":"..."}
// ──────────────────────────────────────────────────────────────

class Request
{
    [JsonPropertyName("id")]           public string  Id           { get; set; } = "";
    [JsonPropertyName("action")]       public string  Action       { get; set; } = "";
    [JsonPropertyName("imagePath")]    public string? ImagePath    { get; set; }
    [JsonPropertyName("outputPath")]   public string? OutputPath   { get; set; }
    [JsonPropertyName("scale")]        public int     Scale        { get; set; } = 2;
    [JsonPropertyName("originalPath")] public string? OriginalPath { get; set; }
    [JsonPropertyName("currentPath")]  public string? CurrentPath  { get; set; }
    [JsonPropertyName("x")]            public int     X            { get; set; }
    [JsonPropertyName("y")]            public int     Y            { get; set; }
    [JsonPropertyName("mode")]         public string  Mode         { get; set; } = "erase";
    [JsonPropertyName("tolerance")]    public int     Tolerance    { get; set; } = 30;
    [JsonPropertyName("cutoff")]       public int     Cutoff       { get; set; } = 100;
    [JsonPropertyName("target")]       public string  Target       { get; set; } = "complex";
    [JsonPropertyName("borderR")]      public int     BorderR      { get; set; } = 255;
    [JsonPropertyName("borderG")]      public int     BorderG      { get; set; } = 255;
    [JsonPropertyName("borderB")]      public int     BorderB      { get; set; } = 255;
    [JsonPropertyName("origPath")]     public string? OrigPath     { get; set; }
}

static class Program
{
    static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    static async Task Main(string[] args)
    {
        // ── 環境に応じた modelsDir の動的解決 ────────────────────────────
        // 優先順位:
        //   [env]  QS_MODELS_DIR 環境変数 (CI / デバッグ用明示的オーバーライド)
        //   [0]    Prod  : <install>/resources/ai-worker/../models
        //                  = <install>/resources/models/          ← extraResources の配置先
        //   [1]    Dev   : <project>/resources/ai-worker/../../models
        //                  = <project>/models/                    ← electron:dev 時 (build:ai-worker でコピー済み)
        //   [2]    DotNet: <project>/ai-worker/bin/…/publish/../../../../../models
        //                  = <project>/models/                    ← dotnet publish 直接実行時
        //   [3]    AppData フォールバック (モデル未ダウンロード時)
        var modelsDir = Environment.GetEnvironmentVariable("QS_MODELS_DIR");

        if (string.IsNullOrEmpty(modelsDir))
        {
            var baseDir = AppContext.BaseDirectory;
            var appDataModels = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "MOZ-3 Quick Shot", "models");

            var candidates = new[]
            {
                Path.GetFullPath(Path.Combine(baseDir, "..", "models")),
                Path.GetFullPath(Path.Combine(baseDir, "..", "..", "models")),
                Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "..", "models")),
                appDataModels,
            };

            modelsDir = null;
            foreach (var candidate in candidates)
            {
                if (HasModelFiles(candidate))
                {
                    modelsDir = candidate;
                    Console.Error.WriteLine($"[ModelsPath] Resolved: {candidate}");
                    break;
                }
                Console.Error.WriteLine($"[ModelsPath] Not found: {candidate}");
            }

            // どの候補にもモデルが見つからない場合は AppData にフォールバック
            if (modelsDir is null)
            {
                modelsDir = appDataModels;
                Console.Error.WriteLine($"[ModelsPath] No models found in any candidate; using AppData fallback: {modelsDir}");
            }
        }
        else
        {
            Console.Error.WriteLine($"[ModelsPath] QS_MODELS_DIR override: {modelsDir}");
        }
        
        Directory.CreateDirectory(modelsDir);

        using var bgEngine = new BGRemovalEngine(modelsDir);

        WriteJson(new { ready = true, modelsDir });

        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            Request req;
            try   { req = JsonSerializer.Deserialize<Request>(line, JsonOpts)!; }
            catch { WriteJson(new { id = "?", success = false, error = "Invalid JSON" }); continue; }

            try
            {
                var result = await Dispatch(req, bgEngine);
                WriteJson(result);
            }
            catch (Exception ex)
            {
                WriteJson(new { id = req.Id, success = false, error = ex.Message });
            }
        }
    }

    /// <summary>
    /// 指定のディレクトリに最低限のモデルファイルが存在するか確認する (u2net.onnx or isnetis.onnx)
    /// </summary>
    static bool HasModelFiles(string modelsDir)
    {
        if (!Directory.Exists(modelsDir)) return false;
        return File.Exists(Path.Combine(modelsDir, "u2net.onnx")) ||
               File.Exists(Path.Combine(modelsDir, "isnetis.onnx"));
    }

    static async Task<object> Dispatch(Request req, BGRemovalEngine bgEngine)
    {
        switch (req.Action)
        {
            case "ping":
                return new { id = req.Id, pong = true };

            case "status":
                return new { id = req.Id, ready = true, modelReady = bgEngine.IsModelReady() };

            // ── U2-Net: 背景透過 ──────────────────────────────────────
            case "removebg":
                if (string.IsNullOrEmpty(req.ImagePath))
                    return new { id = req.Id, success = false, error = "imagePath required" };
                if (string.IsNullOrEmpty(req.OutputPath))
                    return new { id = req.Id, success = false, error = "outputPath required" };
                if (!bgEngine.IsModelReady())
                    return new { id = req.Id, success = false, error = "u2net model not ready" };
                {
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    await bgEngine.RemoveBgAsync(req.ImagePath, req.OutputPath, req.Target);
                    sw.Stop();
                    return new { id = req.Id, success = true, processingMs = sw.ElapsedMilliseconds };
                }

            // ── SR アップスケール ──────────────────────────────────────
            case "sr-upscale":
                if (string.IsNullOrEmpty(req.ImagePath))
                    return new { id = req.Id, success = false, error = "imagePath required" };
                if (string.IsNullOrEmpty(req.OutputPath))
                    return new { id = req.Id, success = false, error = "outputPath required" };
                {
                    int scale = req.Scale is 2 or 4 ? req.Scale : 2;
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    await UpscaleEngine.UpscaleAsync(req.ImagePath, req.OutputPath, scale);
                    sw.Stop();
                    return new { id = req.Id, success = true, processingMs = sw.ElapsedMilliseconds };
                }

            // ── BFS FloodFill リファイン ───────────────────────────────
            case "refine":
                if (string.IsNullOrEmpty(req.OriginalPath))
                    return new { id = req.Id, success = false, error = "originalPath required" };
                if (string.IsNullOrEmpty(req.CurrentPath))
                    return new { id = req.Id, success = false, error = "currentPath required" };
                if (string.IsNullOrEmpty(req.OutputPath))
                    return new { id = req.Id, success = false, error = "outputPath required" };
                {
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    await RefineEngine.RefineAsync(
                        req.OriginalPath, req.CurrentPath,
                        req.X, req.Y, req.Mode,
                        req.OutputPath);
                    sw.Stop();
                    return new { id = req.Id, success = true, processingMs = sw.ElapsedMilliseconds };
                }

            // ── 白枠ステッカー（Dilation + Gaussian Blur + AA 合成）────────
            case "white-border":
                if (string.IsNullOrEmpty(req.ImagePath))
                    return new { id = req.Id, success = false, error = "imagePath required" };
                if (string.IsNullOrEmpty(req.OutputPath))
                    return new { id = req.Id, success = false, error = "outputPath required" };
                {
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    await WhiteBorderEngine.AddWhiteBorderAsync(
                        req.ImagePath, req.OutputPath, req.OrigPath,
                        (byte)Math.Clamp(req.BorderR, 0, 255),
                        (byte)Math.Clamp(req.BorderG, 0, 255),
                        (byte)Math.Clamp(req.BorderB, 0, 255));
                    sw.Stop();
                    return new { id = req.Id, success = true, processingMs = sw.ElapsedMilliseconds };
                }

            case "exit":
                Environment.Exit(0);
                return new { };

            default:
                return new { id = req.Id, success = false, error = $"Unknown action: {req.Action}" };
        }
    }

    static void WriteJson(object obj)
    {
        Console.WriteLine(JsonSerializer.Serialize(obj, JsonOpts));
        Console.Out.Flush();
    }
}
