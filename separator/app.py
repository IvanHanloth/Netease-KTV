"""Netease-KTV separation service.

A small FastAPI wrapper around python-audio-separator. It writes
`instrumental.flac` (backing vocals kept), `vocals.flac` (lead vocal) and
`pitch.json` (lead-vocal melody for scoring) for each job.

Two ways to hand over files:
- Upload (works from any machine on the LAN): `POST /files` the input, create the
  job with `input_file`, fetch results from `GET /jobs/{id}/files/{name}`, then
  `DELETE /jobs/{id}`. Several of these servers can work for one KTV host.
- Shared volume (legacy): absolute `input` / `output_dir` paths under ALLOWED_ROOT.

Set SEPARATOR_TOKEN to require `Authorization: Bearer <token>` on the job API.

- Separation runs one job at a time on a worker thread, so the GPU is never
  shared, and the model is loaded once and reused.
- Pitch extraction runs in a child process: it is CPU-bound pure Python/numba
  work that would otherwise hold the GIL and freeze the HTTP API. It also lets
  the next song start separating while the previous song's pitch is computed.
- A job reports `stems_ready` as soon as the stems are written, so the song is
  playable before its pitch track exists.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

log = logging.getLogger("separator")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

GPU_DEFAULT_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
CPU_DEFAULT_MODEL = "UVR_MDXNET_KARA_2.onnx"
MODEL_DIR = os.environ.get("MODEL_DIR", "/models")
# Only paths under this root are accepted (empty = no restriction, for local dev).
ALLOWED_ROOT = os.environ.get("ALLOWED_ROOT", "")
# Uploaded inputs and the outputs of upload-mode jobs live here until the host deletes the job.
JOBS_DIR = Path(os.environ.get("JOBS_DIR") or (Path(tempfile.gettempdir()) / "ktv-jobs"))
TOKEN = os.environ.get("SEPARATOR_TOKEN", "")

PITCH_SR = 8000
PITCH_HOP = 160  # 20 ms at 8 kHz


# ---------------------------------------------------------------------------
# Pitch extraction (also runnable as `python app.py --pitch <vocals> <dest>`)
# ---------------------------------------------------------------------------


def extract_pitch(vocals: Path, dest: Path) -> None:
    """Write the lead vocal's melody as MIDI floats (null = unvoiced) for scoring."""
    import librosa
    import numpy as np

    y, sr = librosa.load(str(vocals), sr=PITCH_SR, mono=True)
    f0, voiced, _ = librosa.pyin(
        y,
        fmin=65.0,
        fmax=1050.0,
        sr=sr,
        frame_length=512,
        hop_length=PITCH_HOP,
        resolution=0.2,  # 20-cent bins: plenty for scoring, ~4x cheaper Viterbi than the default
    )
    rms = librosa.feature.rms(y=y, frame_length=512, hop_length=PITCH_HOP)[0]
    n = min(len(f0), len(rms))
    f0, voiced, rms = f0[:n], voiced[:n], rms[:n]
    # Drop quiet frames: separation leaves faint bleed that pyin happily tracks.
    loud = rms > max(1e-4, float(np.max(rms)) * 0.03)
    ok = voiced & loud & np.isfinite(f0)
    midi = np.full(n, np.nan)
    midi[ok] = librosa.hz_to_midi(f0[ok])

    # Median-smooth inside voiced runs and remove blips shorter than 80 ms.
    out: list = [None] * n
    i = 0
    while i < n:
        if not ok[i]:
            i += 1
            continue
        j = i
        while j < n and ok[j]:
            j += 1
        if j - i >= 4:
            run = midi[i:j]
            for k in range(i, j):
                lo, hi = max(i, k - 2), min(j, k + 3)
                out[k] = round(float(np.median(run[lo - i : hi - i])), 2)
        i = j

    tmp = dest.with_suffix(".part")
    tmp.write_text(json.dumps({"hop": PITCH_HOP / PITCH_SR, "midi": out}, separators=(",", ":")))
    os.replace(tmp, dest)


ALIGN_SR = 11025
ALIGN_HOP = 256  # ~23 ms


def align_audio(song_wav: Path, mv_wav: Path, dest: Path) -> None:
    """Find the MV's offset against the song: videoTime = audioTime + offset.

    1. Cross-correlate z-scored onset-strength envelopes to find the lag (±120 s).
    2. Confidence = onset correlation at that lag × chroma similarity gain over wrong lags.
    Calibrated on real pairs: same recording → ~1.0, different songs / truncated MV → 0.
    """
    import librosa
    import numpy as np
    import scipy.signal

    y1, _ = librosa.load(str(song_wav), sr=ALIGN_SR, mono=True)
    y2, _ = librosa.load(str(mv_wav), sr=ALIGN_SR, mono=True)

    def env(y):
        e = librosa.onset.onset_strength(y=y, sr=ALIGN_SR, hop_length=ALIGN_HOP)
        return (e - e.mean()) / (e.std() + 1e-9)

    e1, e2 = env(y1), env(y2)
    c = scipy.signal.correlate(e2, e1, mode="full", method="fft")
    lags = np.arange(-len(e1) + 1, len(e2))
    valid = np.abs(lags) <= int(120 * ALIGN_SR / ALIGN_HOP)
    k = int(np.argmax(np.where(valid, c, -np.inf)))
    lag = int(lags[k])
    overlap = min(len(e1), len(e2) - lag) - max(0, -lag)
    r_peak = float(c[k] / max(1, overlap))

    hop_c = ALIGN_HOP * 4
    ch1 = librosa.feature.chroma_cens(y=y1, sr=ALIGN_SR, hop_length=hop_c)
    ch2 = librosa.feature.chroma_cens(y=y2, sr=ALIGN_SR, hop_length=hop_c)

    def chroma_sim(l: int) -> float:
        n0, n1 = max(0, -l), min(ch1.shape[1], ch2.shape[1] - l)
        if n1 - n0 < 50:
            return 0.0
        a, b = ch1[:, n0:n1], ch2[:, n0 + l : n1 + l]
        s = (a * b).sum(0) / (np.linalg.norm(a, axis=0) * np.linalg.norm(b, axis=0) + 1e-9)
        return float(np.median(s))

    lc = int(round(lag / 4))
    gain = chroma_sim(lc) - float(np.mean([chroma_sim(lc + d) for d in (-97, -61, -37, 41, 67, 103)]))
    overlap_s = overlap * ALIGN_HOP / ALIGN_SR
    confidence = 0.0
    if overlap_s >= 30:
        confidence = float(np.clip((r_peak - 0.3) / 0.5, 0, 1) * np.clip(gain / 0.05, 0, 1))

    result = {
        "offset": round(lag * ALIGN_HOP / ALIGN_SR, 3),
        "confidence": round(confidence, 3),
        "r_peak": round(r_peak, 3),
        "chroma_gain": round(gain, 3),
        "overlap_s": round(overlap_s, 1),
    }
    tmp = dest.with_suffix(".part")
    tmp.write_text(json.dumps(result))
    os.replace(tmp, dest)


if __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "--pitch":
    extract_pitch(Path(sys.argv[2]), Path(sys.argv[3]))
    sys.exit(0)

if __name__ == "__main__" and len(sys.argv) == 5 and sys.argv[1] == "--align":
    align_audio(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
    sys.exit(0)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

import re  # noqa: E402

from fastapi import Depends, FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402


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
    mode: str = "separate"
    input2: Optional[str] = None
    # Upload mode: inputs were uploaded; outputs stay in JOBS_DIR until the host deletes the job.
    uploaded: bool = False
    # The host already asked to delete it while it was still running.
    drop_when_done: bool = False
    status: str = "queued"  # queued | running | done | error
    stems_ready: bool = False
    progress: float = 0.0
    error: Optional[str] = None
    outputs: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None

    def view(self) -> dict:
        progress = self.progress
        if self.status == "running" and not self.stems_ready and self.started_at and self.duration_ms > 0:
            expected = max(5.0, self.duration_ms / 1000 * speed_factor)
            progress = min(0.95, (time.time() - self.started_at) / expected)
        return {
            "id": self.id,
            "status": self.status,
            "stems_ready": self.stems_ready,
            "progress": round(progress, 3),
            "outputs": self.outputs,
            "error": self.error,
        }


class JobIn(BaseModel):
    song_id: int
    # Shared-volume mode: absolute paths. Upload mode: leave empty and pass input_file (from POST /files).
    input: str = ""
    output_dir: str = ""
    input_file: Optional[str] = None
    input2_file: Optional[str] = None
    duration_ms: int = 0
    model: Optional[str] = None
    # "separate": stems + pitch; "pitch": only extract pitch from an existing vocals stem (input);
    # "align": MV offset from two WAVs (input = song, input2 = MV audio).
    mode: str = "separate"
    input2: Optional[str] = None


jobs: dict[str, Job] = {}
pending: "queue.Queue[str]" = queue.Queue()

# Startup stage reported by /health: starting -> preparing_model -> ready (or error).
stage = "starting"
stage_error: Optional[str] = None

_separator = None
_loaded_model: Optional[str] = None
_work_dir = Path(tempfile.mkdtemp(prefix="ktv-sep-"))


def check_path(p: str) -> Path:
    path = Path(p).resolve()
    if ALLOWED_ROOT and not str(path).startswith(str(Path(ALLOWED_ROOT).resolve())):
        raise HTTPException(400, f"path outside ALLOWED_ROOT: {p}")
    return path


def job_path(job: Job, p: str) -> Path:
    """Upload-mode jobs live in JOBS_DIR (ours); shared-volume paths must stay under ALLOWED_ROOT."""
    return Path(p).resolve() if job.uploaded else check_path(p)


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


def finish(job: Job, error: Optional[str] = None) -> None:
    job.finished_at = time.time()
    if error:
        job.status, job.error = "error", error
    else:
        job.status, job.progress = "done", 1.0
    if job.drop_when_done:
        drop_job(job)
        jobs.pop(job.id, None)


def drop_job(job: Job) -> None:
    """Upload mode: remove the job's inputs and outputs."""
    if not job.uploaded:
        return
    shutil.rmtree(job.output_dir, ignore_errors=True)
    for p in (job.input, job.input2):
        if p:
            Path(p).unlink(missing_ok=True)


def sweep_uploads(cutoff: float) -> None:
    """Uploads that never became a job (the host went away mid-way) are removed after an hour."""
    folder = JOBS_DIR / "uploads"
    if not folder.exists():
        return
    in_use = {p for j in jobs.values() for p in (j.input, j.input2) if p}
    for f in folder.iterdir():
        try:
            if str(f) not in in_use and f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
        except OSError:
            pass


def start_pitch(job: Job, vocals: Path, out_dir: Path) -> None:
    """Extract pitch in a child process; the job finishes when it exits."""
    dest = out_dir / "pitch.json"

    def wait() -> None:
        t0 = time.time()
        try:
            proc = subprocess.run(
                [sys.executable, os.path.abspath(__file__), "--pitch", str(vocals), str(dest)],
                capture_output=True,
                text=True,
                timeout=900,
            )
            if proc.returncode == 0 and dest.exists():
                job.outputs["pitch"] = str(dest)
                log.info("song %s pitch extracted in %.1fs", job.song_id, time.time() - t0)
            else:
                log.warning("pitch extraction failed for song %s: %s", job.song_id, proc.stderr[-500:])
        except Exception:
            log.exception("pitch extraction crashed for song %s", job.song_id)
        # A missing pitch track only disables scoring; the stems are still good.
        if job.mode == "pitch" and "pitch" not in job.outputs:
            finish(job, "pitch extraction failed")
        else:
            finish(job)

    threading.Thread(target=wait, daemon=True, name=f"pitch-{job.song_id}").start()


def start_align(job: Job, song_wav: Path, mv_wav: Path, out_dir: Path) -> None:
    """MV alignment in a child process (CPU-bound; keeps the API and the GPU worker free)."""
    dest = out_dir / "mv_align.json"

    def wait() -> None:
        t0 = time.time()
        try:
            proc = subprocess.run(
                [sys.executable, os.path.abspath(__file__), "--align", str(song_wav), str(mv_wav), str(dest)],
                capture_output=True,
                text=True,
                timeout=600,
            )
            if proc.returncode == 0 and dest.exists():
                job.outputs["align"] = str(dest)
                log.info("song %s MV aligned in %.1fs: %s", job.song_id, time.time() - t0, dest.read_text())
                finish(job)
            else:
                finish(job, f"align failed: {proc.stderr[-500:]}")
        except Exception as err:
            log.exception("align crashed for song %s", job.song_id)
            finish(job, str(err))

    threading.Thread(target=wait, daemon=True, name=f"align-{job.song_id}").start()


def run_job(job: Job) -> None:
    global speed_factor
    job.status = "running"
    job.started_at = time.time()
    try:
        out_dir = job_path(job, job.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        if job.mode == "pitch":
            start_pitch(job, job_path(job, job.input), out_dir)
            return
        if job.mode == "align":
            start_align(job, job_path(job, job.input), job_path(job, job.input2 or ""), out_dir)
            return

        sep = get_separator(job.model)
        for f in _work_dir.iterdir():
            f.unlink(missing_ok=True)
        t0 = time.time()
        produced = sep.separate(str(job_path(job, job.input)))
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

        elapsed = time.time() - t0
        if job.duration_ms > 0:
            speed_factor = 0.7 * speed_factor + 0.3 * (elapsed / (job.duration_ms / 1000))
        log.info("song %s separated in %.1fs", job.song_id, elapsed)
        job.stems_ready = True
        job.progress = 1.0
        start_pitch(job, out_dir / "vocals.flac", out_dir)
    except Exception as err:  # report any failure back to the app
        log.exception("job %s failed", job.id)
        finish(job, str(err))


def warmup() -> None:
    """Download (first run only) and load the default model so the first song doesn't wait for it."""
    global stage, stage_error
    if os.environ.get("PRELOAD_MODEL", "1") == "0":
        stage = "ready"
        return
    stage = "preparing_model"
    log.info("preparing model %s on %s (first run downloads it into %s)", DEFAULT_MODEL, DEVICE, MODEL_DIR)
    try:
        get_separator(DEFAULT_MODEL)
        stage = "ready"
        log.info("model ready")
    except Exception as err:
        log.exception("model warmup failed; it will be retried on the first job")
        stage, stage_error = "error", str(err)


def worker() -> None:
    global stage, stage_error
    warmup()
    while True:
        job_id = pending.get()
        job = jobs.get(job_id)
        if job and job.status == "queued":
            run_job(job)
            if job.stems_ready and stage == "error":
                stage, stage_error = "ready", None


# Finished jobs whose host never collected them (it went away, or crashed) are forgotten after this.
FORGET_AFTER_S = 3600
SWEEP_EVERY_S = 600


def sweep() -> None:
    """Free disk space that nothing will ask for any more."""
    cutoff = time.time() - FORGET_AFTER_S
    for jid in [j.id for j in list(jobs.values()) if j.finished_at and j.finished_at < cutoff]:
        job = jobs.pop(jid, None)
        if job:
            drop_job(job)
    sweep_uploads(cutoff)
    # Output dirs of jobs this process doesn't know: left over from before a restart.
    folder = JOBS_DIR / "jobs"
    if folder.exists():
        for d in folder.iterdir():
            try:
                if d.name not in jobs and d.stat().st_mtime < cutoff:
                    shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass


def sweeper() -> None:
    # Scratch dirs of earlier processes (each start makes a new one).
    for d in Path(tempfile.gettempdir()).glob("ktv-sep-*"):
        if d != _work_dir:
            shutil.rmtree(d, ignore_errors=True)
    while True:
        try:
            sweep()
        except Exception:  # never let cleanup kill the thread
            log.exception("sweep failed")
        time.sleep(SWEEP_EVERY_S)


app = FastAPI(title="Netease-KTV separator")


@app.on_event("startup")
def _start_worker() -> None:
    threading.Thread(target=worker, daemon=True, name="separator-worker").start()
    threading.Thread(target=sweeper, daemon=True, name="separator-sweeper").start()


def auth(request: Request) -> None:
    if TOKEN and request.headers.get("authorization", "") != f"Bearer {TOKEN}":
        raise HTTPException(401, "invalid separator token")


@app.get("/health")
def health() -> dict:
    separating = [j for j in jobs.values() if j.mode == "separate" and not j.stems_ready and j.status in ("queued", "running")]
    return {
        "ok": True,
        "ready": stage == "ready",
        "stage": stage,
        "error": stage_error,
        "device": DEVICE,
        "gpu": HAS_GPU,
        "model": _loaded_model or DEFAULT_MODEL,
        "default_model": DEFAULT_MODEL,
        "pending": pending.qsize() + sum(1 for j in jobs.values() if j.status == "running"),
        # Separations waiting for / running on the worker (pitch and align run on the side).
        "queue": len(separating),
        # Seconds of processing per second of audio (moving average), used by the host's scheduler.
        "speed_factor": round(speed_factor, 3),
        "upload": True,
        "auth": bool(TOKEN),
        "api": 2,
    }


FILE_RE = re.compile(r"^[0-9a-f]{32}\.[a-z0-9]{1,5}$")


def uploaded_path(name: Optional[str]) -> Path:
    if not name or not FILE_RE.match(name):
        raise HTTPException(400, "bad file id")
    p = JOBS_DIR / "uploads" / name
    if not p.exists():
        raise HTTPException(404, "uploaded file not found")
    return p


@app.post("/files", dependencies=[Depends(auth)])
async def upload_file(request: Request, ext: str = "bin") -> dict:
    """Raw request body = file contents. Returns the id to pass as input_file / input2_file."""
    ext = re.sub(r"[^a-z0-9]", "", ext.lower())[:5] or "bin"
    name = f"{uuid.uuid4().hex}.{ext}"
    folder = JOBS_DIR / "uploads"
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / (name + ".part")
    size = 0
    with open(tmp, "wb") as f:
        async for chunk in request.stream():
            size += len(chunk)
            f.write(chunk)
    if size == 0:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, "empty upload")
    os.replace(tmp, folder / name)
    return {"file": name, "size": size}


@app.post("/jobs", dependencies=[Depends(auth)])
def create_job(body: JobIn) -> dict:
    job_id = uuid.uuid4().hex
    mode = body.mode if body.mode in ("pitch", "align") else "separate"
    if body.input_file:
        inp = str(uploaded_path(body.input_file))
        inp2 = str(uploaded_path(body.input2_file)) if mode == "align" else None
        out = str(JOBS_DIR / "jobs" / job_id)
        uploaded = True
    else:
        check_path(body.input)
        check_path(body.output_dir)
        if not Path(body.input).exists():
            raise HTTPException(404, "input file not found")
        if mode == "align" and (not body.input2 or not check_path(body.input2).exists()):
            raise HTTPException(404, "input2 file not found")
        inp, inp2, out, uploaded = body.input, body.input2, body.output_dir, False
    job = Job(
        id=job_id,
        song_id=body.song_id,
        input=inp,
        output_dir=out,
        duration_ms=body.duration_ms,
        model=body.model or DEFAULT_MODEL,
        mode=mode,
        input2=inp2,
        uploaded=uploaded,
    )
    jobs[job.id] = job
    pending.put(job.id)
    return {"id": job.id}


@app.get("/jobs/{job_id}", dependencies=[Depends(auth)])
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job.view()


@app.get("/jobs/{job_id}/files/{name}", dependencies=[Depends(auth)])
def get_job_file(job_id: str, name: str):
    """Download an output of an upload-mode job: instrumental, vocals, pitch or align."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    path = job.outputs.get(name)
    if not path or not Path(path).exists():
        raise HTTPException(404, "output not ready")
    return FileResponse(path)


@app.delete("/jobs/{job_id}", dependencies=[Depends(auth)])
def delete_job(job_id: str) -> dict:
    """The host has what it needs (or gave up): free the disk space."""
    job = jobs.get(job_id)
    if not job:
        return {"ok": True}
    if job.status == "queued":
        # Not started: the worker skips it.
        job.status, job.error, job.finished_at = "error", "cancelled", time.time()
    if job.status in ("done", "error"):
        drop_job(job)
        jobs.pop(job_id, None)
    else:
        job.drop_when_done = True
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "9000")))
