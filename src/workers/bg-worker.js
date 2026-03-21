import { pipeline, env } from '@huggingface/transformers';

// ElectronのNode環境と完全に分離されたWeb Worker内で動作するため、
// 余計なWASM設定やパスの明示なしにブラウザネイティブの動作が可能になります
env.allowLocalModels = false;
env.useBrowserCache = true;

let segmenter = null;

self.onmessage = async (e) => {
    try {
        const { imageUrl } = e.data;

        if (!segmenter) {
            // Web Worker内ならwasmが最も安定して高速に動作します
            // Transformers.js V3以降は自動的に適切なバックエンドを選択します
            segmenter = await pipeline('image-segmentation', 'briaai/RMBG-1.4', {
                device: 'wasm'
            });
        }

        const result = await segmenter(imageUrl);
        const maskBlob = await result[0].mask.toBlob();

        self.postMessage({ success: true, maskBlob });
    } catch (err) {
        self.postMessage({ success: false, error: err.message });
    }
};
