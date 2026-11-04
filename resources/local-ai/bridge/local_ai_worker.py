import argparse
import gc
import json
import os
import re
import sys
import time
import traceback


PROTOCOL_OUT = sys.stdout


def emit(payload: dict) -> None:
    PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    PROTOCOL_OUT.flush()


def fail(request_id, code: str, message: str) -> None:
    emit({
        "id": request_id,
        "error": {
            "code": code,
            "message": message,
        },
    })


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-root", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--max-image-side", type=int, default=320)
    parser.add_argument("--max-tokens", type=int, default=640)
    return parser.parse_args()


def strip_code_fence(text: str) -> str:
    value = text.strip()
    match = re.match(r"^```(?:json)?\s*([\s\S]*?)\s*```$", value, re.IGNORECASE)
    return match.group(1).strip() if match else value


def extract_json(text: str):
    cleaned = strip_code_fence(text)
    try:
        return json.loads(cleaned)
    except Exception:
        pass
    starts = [index for index in (cleaned.find("{"), cleaned.find("[")) if index >= 0]
    if not starts:
        raise ValueError("模型没有返回 JSON")
    start = min(starts)
    end_object = cleaned.rfind("}")
    end_array = cleaned.rfind("]")
    end = max(end_object, end_array)
    if end < start:
        raise ValueError("模型返回的 JSON 不完整")
    return json.loads(cleaned[start:end + 1])


class QwenVisionAnalyzer:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.clip = None
        self.torch = None
        self.image = None
        self.numpy = None
        self._loaded = False

    def load(self) -> None:
        if self._loaded:
            return

        comfy_root = os.path.abspath(self.args.comfy_root)
        if not os.path.isdir(comfy_root):
            raise RuntimeError(f"ComfyUI 运行目录不存在：{comfy_root}")
        if not os.path.isfile(self.args.model_path):
            raise RuntimeError(f"本地视觉模型不存在：{self.args.model_path}")

        os.chdir(comfy_root)
        sys.path.insert(0, comfy_root)
        sys.argv = [os.path.join(comfy_root, "main.py")]

        import comfy.options
        comfy.options.enable_args_parsing()
        from comfy.cli_args import args as comfy_args
        comfy_args.disable_all_custom_nodes = True
        comfy_args.disable_api_nodes = True
        comfy_args.disable_auto_launch = True
        comfy_args.cpu = False
        comfy_args.highvram = False
        comfy_args.reserve_vram = 0.35

        import folder_paths
        import comfy.sd
        import torch
        from PIL import Image
        import numpy as np

        self.clip = comfy.sd.load_clip(
            ckpt_paths=[self.args.model_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=comfy.sd.CLIPType.STABLE_DIFFUSION,
        )
        self.torch = torch
        self.image = Image
        self.numpy = np
        self._loaded = True

    def unload(self) -> None:
        self.clip = None
        if self.torch is not None and self.torch.cuda.is_available():
            self.torch.cuda.empty_cache()
        gc.collect()

    def _image_tensor(self, image_path: str):
        if not os.path.isfile(image_path):
            raise RuntimeError(f"镜头代表帧不存在：{image_path}")
        image = self.image.open(image_path).convert("RGB")
        image.thumbnail((self.args.max_image_side, self.args.max_image_side), self.image.Resampling.LANCZOS)
        array = self.numpy.asarray(image).astype(self.numpy.float32) / 255.0
        return self.torch.from_numpy(array).unsqueeze(0)

    def analyze_batch(self, items: list[dict]) -> list[dict]:
        count = len(items)
        images = [self._image_tensor(item["imagePath"]) for item in items]
        prompt = (
            f"按输入顺序分析 {count} 张影视镜头代表帧。只输出一个 JSON 对象，不要 Markdown，不要解释。"
            '格式为 {"shots":[{'
            '"index":1,'
            '"remark":"不超过60字的画面描述",'
            '"shot_size":"远景|全景|中景|近景|特写|空镜",'
            '"camera_method":"正面|侧面|过肩|俯拍|仰拍|未知",'
            '"movement":"固定|推|拉|摇|跟|手持|未知",'
            '"lighting":"自然光|冷光|暖光|逆光|硬光|霓虹|低照度|未知",'
            '"subjects":["主体1","主体2"]'
            "}]}。"
            f"必须返回 {count} 项，index 必须与输入顺序一致。只描述画面中可见内容，不要猜测剧情。"
        )
        tokens = self.clip.tokenize(prompt, images=images)
        generated = self.clip.generate(
            tokens,
            do_sample=False,
            max_length=max(256, self.args.max_tokens),
            temperature=0.1,
            top_k=1,
            top_p=1.0,
            min_p=0.0,
            repetition_penalty=1.05,
            seed=42,
        )
        decoded = self.clip.decode(generated, skip_special_tokens=True)
        parsed = extract_json(decoded)
        shots = parsed.get("shots") if isinstance(parsed, dict) else parsed
        if not isinstance(shots, list):
            raise ValueError("模型返回中没有 shots 数组")

        by_index = {}
        for shot in shots:
            if not isinstance(shot, dict):
                continue
            try:
                index = int(shot.get("index"))
            except Exception:
                continue
            by_index[index] = shot

        results = []
        for position, item in enumerate(items, start=1):
            shot = by_index.get(position, {})
            shot_size = str(shot.get("shot_size") or "未知").strip()
            camera = str(shot.get("camera_method") or "未知").strip()
            movement = str(shot.get("movement") or "未知").strip()
            lighting = str(shot.get("lighting") or "未知").strip()
            subjects = shot.get("subjects")
            if not isinstance(subjects, list):
                subjects = []
            subjects = [str(subject).strip() for subject in subjects if str(subject).strip()][:6]
            remark = str(shot.get("remark") or "本地视觉模型未返回画面描述").strip()[:120]
            results.append({
                "id": item["id"],
                "index": item.get("index", position),
                "remark": remark,
                "shotSize": shot_size,
                "cameraMethod": camera,
                "movement": movement,
                "lighting": lighting,
                "subjects": subjects,
                "tags": {
                    "景别": [] if shot_size == "未知" else [shot_size],
                    "机位": [] if camera == "未知" else [camera],
                    "运镜": [] if movement == "未知" else [movement],
                    "光线": [] if lighting == "未知" else [lighting],
                },
                "confidence": 0.72,
            })
        return results


def main() -> None:
    cli = parse_args()

    # 第三方日志和 tqdm 统一写入 stderr，stdout 只承载协议 JSON。
    sys.stdout = sys.stderr
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

    analyzer = QwenVisionAnalyzer(cli)
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = request.get("method")
            params = request.get("params") or {}
            if method == "health":
                emit({
                    "id": request_id,
                    "result": {
                        "available": os.path.isdir(cli.comfy_root) and os.path.isfile(cli.model_path),
                        "loaded": analyzer._loaded,
                        "comfyRoot": cli.comfy_root,
                        "modelPath": cli.model_path,
                    },
                })
                continue
            if method != "analyze":
                fail(request_id, "METHOD_UNKNOWN", f"未知方法：{method}")
                continue

            items = params.get("items")
            if not isinstance(items, list) or not items:
                fail(request_id, "ITEMS_EMPTY", "没有需要分析的镜头")
                continue
            batch_size = max(1, min(4, int(params.get("batchSize") or cli.batch_size)))
            total = len(items)
            started = time.perf_counter()
            analyzer.load()
            emit({"id": request_id, "method": "progress", "params": {"percent": 2, "completed": 0, "total": total}})
            results = []
            for start in range(0, total, batch_size):
                batch = items[start:start + batch_size]
                results.extend(analyzer.analyze_batch(batch))
                completed = len(results)
                emit({
                    "id": request_id,
                    "method": "progress",
                    "params": {
                        "percent": max(3, min(99, round(completed / total * 100))),
                        "completed": completed,
                        "total": total,
                    },
                })
            emit({
                "id": request_id,
                "result": {
                    "items": results,
                    "elapsedMs": round((time.perf_counter() - started) * 1000),
                    "model": "qwen3vl-8b-w4a8",
                },
            })
            analyzer.unload()
        except Exception as error:
            analyzer.unload()
            fail(request_id, "LOCAL_AI_FAILED", f"{error}\n{traceback.format_exc(limit=6)}")

    analyzer.unload()


if __name__ == "__main__":
    main()
