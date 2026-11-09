"""Build the portable HTML and a reproducible scoped PWA release.

The service worker version is derived from every shipped source/asset, excluding
its previous generated version. No timestamps, credentials or user data enter it.
"""
from pathlib import Path
import hashlib
import re

p = Path(__file__).parent
dist = p / 'dist'
template = (p / 'template.html').read_text(encoding='utf-8')
sources = [('STYLES', 'styles.css'), ('ENGINE', 'engine.js'), ('MONTHS', 'months.js'), ('PWA', 'pwa.js'), ('APP', 'app.js')]
worker = (dist / 'sw.js').read_text(encoding='utf-8')
worker = re.sub(r"const APP_VERSION = '[^']*';", "const APP_VERSION = '__MARGE_BUILD_VERSION__';", worker, count=1)
digest = hashlib.sha256()
for name, content in [('template.html', template.encode()), ('sw.js', worker.encode())] + [
    (name, (dist / name).read_bytes()) for _, name in sources
] + [('manifest.webmanifest', (dist / 'manifest.webmanifest').read_bytes())] + [
    (str(path.relative_to(dist)), path.read_bytes()) for path in sorted((dist / 'icons').glob('*')) if path.is_file()
]:
    digest.update(name.encode() + b'\0' + content + b'\0')
version = digest.hexdigest()[:16]
s = template
for marker, name in sources:
    s = s.replace('/* ' + marker + ' */', (dist / name).read_text(encoding='utf-8'))
s = s.replace('__MARGE_BUILD_VERSION__', version)
(dist / 'index.html').write_text(s, encoding='utf-8')
(dist / 'sw.js').write_text(worker.replace('__MARGE_BUILD_VERSION__', version), encoding='utf-8')
print('Marge', version, '— index.html autonome :', len(s.encode()), 'octets ; PWA prête dans dist/.')
