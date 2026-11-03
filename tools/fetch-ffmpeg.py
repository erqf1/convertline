# Holt FFmpeg aus dem Python-Paket imageio-ffmpeg nach vendor/<os>-<arch>/ (dieselbe Quelle wie bei Vidline).
# Ohne Angabe: das eigene System, auf dem Mac beide Prozessoren. Sonst z. B.: python tools/fetch-ffmpeg.py win-x64
import io
import json
import pathlib
import stat
import sys
import urllib.request
import zipfile

VERSION = '0.6.0'
ROOT = pathlib.Path(__file__).resolve().parent.parent
WHEELS = {
    'win-x64': lambda n: 'win_amd64' in n,
    'linux-x64': lambda n: 'manylinux' in n and 'x86_64' in n,
    'mac-x64': lambda n: 'macosx' in n and 'x86_64' in n,
    'mac-arm64': lambda n: 'macosx' in n and 'arm64' in n,
}


def own():
    if sys.platform == 'win32':
        return ['win-x64']
    if sys.platform == 'darwin':
        return ['mac-arm64', 'mac-x64']
    return ['linux-x64']


def fetch(target):
    with urllib.request.urlopen(f'https://pypi.org/pypi/imageio-ffmpeg/{VERSION}/json') as r:
        files = json.load(r)['urls']
    url = next(f['url'] for f in files if f['filename'].endswith('.whl') and WHEELS[target](f['filename']))
    print('lade', url)
    with urllib.request.urlopen(url) as r:
        wheel = zipfile.ZipFile(io.BytesIO(r.read()))
    name = next(n for n in wheel.namelist() if '/binaries/ffmpeg' in n)
    out = ROOT / 'vendor' / target
    out.mkdir(parents=True, exist_ok=True)
    exe = out / ('ffmpeg.exe' if target.startswith('win') else 'ffmpeg')
    exe.write_bytes(wheel.read(name))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    print('fertig', exe, exe.stat().st_size)


for t in sys.argv[1:] or own():
    fetch(t)
