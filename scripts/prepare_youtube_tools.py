"""Bundle the desktop YouTube importer and its JS runtime from verified release assets."""
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import urlopen, Request
from zipfile import ZipFile
import hashlib
import platform
import shutil
import sys


RELEASES = {
    "Darwin": [
        ("yt-dlp/yt-dlp", "2026.10.26", "yt-dlp_macos", "yt-dlp", "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa"),
        ("denoland/deno", "v2.9.8", "deno-aarch64-apple-darwin.zip", "deno", "9f0bf660393da2eaff044cdc7444cb08c73f235849b61d224d825a194ce7c98e"),
    ],
    "Windows": [
        ("yt-dlp/yt-dlp", "2026.10.26", "yt-dlp.exe", "yt-dlp.exe", "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d"),
        ("denoland/deno", "v2.9.8", "deno-x86_64-pc-windows-msvc.zip", "deno.exe", "cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf"),
    ],
}


def prepare():
    system = platform.system()
    assets = RELEASES.get(system)
    if not assets:
        return  # Other development platforms can use their locally installed tools.
    if system == "Darwin" and platform.machine() != "arm64":
        sys.exit("Build the supported macOS package on Apple Silicon.")
    destination = Path(__file__).resolve().parents[1] / "src-tauri" / "youtube-tools"
    destination.mkdir(exist_ok=True)
    with TemporaryDirectory(dir=destination.parent) as scratch:
        for repo, release, asset, executable, expected in assets:
            url = f"https://github.com/{repo}/releases/download/{release}/{asset}"
            downloaded = Path(scratch) / "download"
            print(f"Preparing {executable} {release}", flush=True)
            with urlopen(Request(url, headers={"User-Agent": "Subtitler-build"}), timeout=120) as response, downloaded.open("wb") as output:
                shutil.copyfileobj(response, output)
            if hashlib.sha256(downloaded.read_bytes()).hexdigest() != expected:
                sys.exit(f"Checksum mismatch for {asset}")
            if asset.endswith(".zip"):
                binary = Path(scratch) / executable
                with ZipFile(downloaded) as archive, archive.open(executable) as source, binary.open("wb") as output:
                    shutil.copyfileobj(source, output)
            else:
                binary = downloaded
            binary.chmod(0o755)
            binary.replace(destination / executable)


if __name__ == "__main__":
    prepare()
