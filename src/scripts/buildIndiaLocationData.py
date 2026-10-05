"""Compile public GeoNames postal/city dumps. See src/data/README.md for sources."""
import gzip
import json
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

postal_path, cities_path, admin1_path, admin2_path = sys.argv[1:5]

def title(value):
    value = value.replace('State of ', '').replace('Union Territory of ', '').replace('National Capital Territory of ', '')
    return value.replace(' & ', ' and ').replace(' district', '').replace(' District', '')

admin1 = {r[0]: title(r[1]) for line in Path(admin1_path).read_text().splitlines() if len(r := line.split('\t')) >= 2}
admin2 = {r[0]: title(r[1]) for line in Path(admin2_path).read_text().splitlines() if len(r := line.split('\t')) >= 2}
pins = defaultdict(list)
with zipfile.ZipFile(postal_path) as archive:
    for line in archive.read('IN.txt').decode().splitlines():
        r = line.split('\t')
        if len(r) < 12 or not r[1].isdigit() or len(r[1]) != 6 or r[1][0] == '0':
            continue
        try:
            lat, lng = float(r[9]), float(r[10])
        except ValueError:
            continue
        if 6 <= lat <= 38 and 68 <= lng <= 98:
            pins[r[1]].append((title(r[3]), title(r[5]), lat, lng))
postal = []
for pin, rows in sorted(pins.items()):
    pairs = set((r[2], r[3]) for r in rows)
    states = sorted(set(r[0] for r in rows))
    districts = sorted(set(r[1] for r in rows))
    if len(states) != 1:
        continue
    postal.append([pin, states[0], districts[0] if len(districts) == 1 else '', round(sum(p[0] for p in pairs)/len(pairs), 6), round(sum(p[1] for p in pairs)/len(pairs), 6)])
cities = []
with zipfile.ZipFile(cities_path) as archive:
    for line in archive.read('cities1000.txt').decode().splitlines():
        r = line.split('\t')
        if len(r) < 19 or r[8] != 'IN' or r[6] != 'P':
            continue
        state = admin1.get('IN.' + r[10], '')
        district = admin2.get('IN.' + r[10] + '.' + r[11], '')
        aliases = sorted(set([r[1], r[2], *r[3].split(',')]) - {''})
        cities.append([r[2] or r[1], aliases, state, district, float(r[4]), float(r[5])])
data = {'version': 1, 'source': 'GeoNames, CC BY 4.0', 'pins': postal, 'cities': cities}
target = Path(__file__).resolve().parents[1] / 'data' / 'india-locations.json.gz'
with target.open('wb') as output:
    with gzip.GzipFile(fileobj=output, mode='wb', mtime=0) as archive:
        archive.write(json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode())
print(json.dumps({'pins': len(postal), 'cities': len(cities), 'bytes': target.stat().st_size}))
