"""Netease-KTV separation service.

A small FastAPI wrapper around python-audio-separator. The Node app posts jobs
with absolute input/output paths on a shared volume; this service writes
`instrumental.flac` (backing vocals kept) and `vocals.flac` (lead vocal) into
the job's output directory. Jobs run one at a time on a single worker thread so
the GPU is never shared, and the model is loaded once and reused.
"""

from __future__ import annotations

import inspect
import logging
import os
import queue
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

log = logging.getLogger("separator")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

GPU_DEFAULT_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
CPU_DEFAULT_MODEL = "UVR_MDXNET_KARA_2.onnx"
MODEL_DIR = os.environ.get("MODEL_DIR", "/models")
# Only paths under this root are accepted (empty = no restriction, for local dev).
ALLOWED_ROOT = os.environ.get("ALLOWED_ROOT", "")


def detect_device() -> tuple[str, bool]:
    try:
        import torch

        if torch.cuda.is_available():
            return f"cuda · {torch.cuda.get_device_name(0)}", True
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps", True
    except Exception:  # torch missing or broken
        pass
    return "cpu", False


DEVICE, HAS_GPU = detect_device()
DEFAULT_MODEL = os.environ.get("SEPARATOR_MODEL") or (GPU_DEFAULT_MODEL if HAS_GPU else CPU_DEFAULT_MODEL)
# Seconds of processing per second of audio, refined after each job (used for progress estimates).
speed_factor = 0.35 if HAS_GPU else 2.0


@dataclass
class Job:
    id: str
    song_id: int
    input: str
    output_dir: str
    duration_ms: int
    model: str
    status: str = "queued"
    progress: float = 0.0
    error: Optional[str] = None
    outputs: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None

    def view(self) -> dict:
        progress = self.progress
        if self.status == "running" and self.started_at and self.duration_ms > 0:
            expected = max(5.0, self.duration_ms / 1000 * speed_factor)
            progress = min(0.95, (time.time() - self.started_at) / expected)
        return {
            "id": self.id,
            "status": self.status,
            "progress": round(progress, 3),
            "outputs": self.outputs,
            "error": self.error,
        }


class JobIn(BaseModel):
    song_id: int
    input: str
    output_dir: str
    duration_ms: int = 0
    model: Optional[str] = None


jobs: dict[str, Job] = {}
pending: "queue.Queue[str]" = queue.Queue()

_separator = None
_loaded_model: Optional[str] = None
_work_dir = Path(tempfile.mkdtemp(prefix="ktv-sep-"))


def check_path(p: str) -> Path:
    path = Path(p).resolve()
    if ALLOWED_ROOT and not str(path).startswith(str(Path(ALLOWED_ROOT).resolve())):
        raise HTTPException(400, f"path outside ALLOWED_ROOT: {p}")
    return path


def get_separator(model: str):
    """Create the Separator once; reload only when the model changes."""
    global _separator, _loaded_model
    from audio_separator.separator import Separator

    if _separator is None:
        wanted = {
            "log_level": logging.WARNING,
            "model_file_dir": MODEL_DIR,
            "output_dir": str(_work_dir),
            "output_format": "FLAC",
            "use_autocast": HAS_GPU,
        }
        accepted = inspect.signature(Separator.__init__).parameters
        _separator = Separator(**{k: v for k, v in wanted.items() if k in accepted})
    if _loaded_model != model:
        log.info("loading model %s", model)
        _separator.load_model(model_filename=model)
        _loaded_model = model
    return _separator


def classify(name: str) -> Optional[str]:
    """Map an output filename to our stem names."""
    n = name.lower()
    if any(k in n for k in ("(instrumental)", "(no vocals)", "(no_vocals)", "(karaoke)", "(other)", "instrumental")):
        return "instrumental"
    if "vocals" in n or "(lead" in n:
        return "vocals"
    return None


def run_job(job: Job) -> None:
    global speed_factor
    job.status = "running"
    job.started_at = time.time()
    try:
        out_dir = check_path(job.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        sep = get_separator(job.model)
        for f in _work_dir.iterdir():
            f.unlink(missing_ok=True)
        produced = sep.separate(str(check_path(job.input)))
        found: dict[str, Path] = {}
        for item in produced:
            p = Path(item)
            if not p.is_absolute():
                p = _work_dir / p
            stem = classify(p.name)
            if stem and stem not in found:
                found[stem] = p
        if "instrumental" not in found or "vocals" not in found:
            raise RuntimeError(f"unexpected outputs: {[Path(x).name for x in produced]}")
        for stem, src in found.items():
            dest = out_dir / f"{stem}.flac"
            tmp = out_dir / f"{stem}.part.flac"
            shutil.move(str(src), tmp)
            os.replace(tmp, dest)
            job.outputs[stem] = str(dest)
        job.status = "done"
        job.progress = 1.0
        elapsed = time.time() - job.started_at
        if job.duration_ms > 0:
            speed_factor = 0.7 * speed_factor + 0.3 * (elapsed / (job.duration_ms / 1000))
        log.info("song %s separated in %.1fs", job.song_id, elapsed)
    except Exception as err:  # report any failure back to the app
        log.exception("job %s failed", job.id)
        job.status = "error"
        job.error = str(err)
    finally:
        job.finished_at = time.time()


def worker() -> None:
    while True:
        job_id = pending.get()
        job = jobs.get(job_id)
        if job:
            run_job(job)
        # Forget finished jobs after an hour.
        cutoff = time.time() - 3600
        for jid in [j.id for j in jobs.values() if j.finished_at and j.finished_at < cutoff]:
            jobs.pop(jid, None)


threading.Thread(target=worker, daemon=True, name="separator-worker").start()

app = FastAPI(title="Netease-KTV separator")


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "device": DEVICE,
        "model": _loaded_model or DEFAULT_MODEL,
        "pending": pending.qsize() + sum(1 for j in jobs.values() if j.status == "running"),
    }


@app.post("/jobs")
def create_job(body: JobIn) -> dict:
    check_path(body.input)
    check_path(body.output_dir)
    if not Path(body.input).exists():
        raise HTTPException(404, "input file not found")
    job = Job(
        id=uuid.uuid4().hex,
        song_id=body.song_id,
        input=body.input,
        output_dir=body.output_dir,
        duration_ms=body.duration_ms,
        model=body.model or DEFAULT_MODEL,
    )
    jobs[job.id] = job
    pending.put(job.id)
    return {"id": job.id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job.view()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "9000")))
