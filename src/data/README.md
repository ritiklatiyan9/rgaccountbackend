# Indian map locations

`india-locations.json.gz` is a compact, local GeoNames reference: Indian six-digit PIN area centroids and Indian populated places with alternate names, state and district. Locations are approximate areas, never household coordinates. The source data is provided without a guarantee of accuracy or completeness.

Sources downloaded 5 October 2026:

- https://download.geonames.org/export/zip/IN.zip
- https://download.geonames.org/export/dump/cities1000.zip
- https://download.geonames.org/export/dump/admin1CodesASCII.txt
- https://download.geonames.org/export/dump/admin2Codes.txt

Attribution: [GeoNames](https://www.geonames.org/), [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: restricted city records to India, normalized administrative labels, and averaged distinct postal coordinates into PIN centroids. Map attribution links to GeoNames alongside OpenStreetMap.

To regenerate, download those four public files and run `python3 src/scripts/buildIndiaLocationData.py IN.zip cities1000.zip admin1CodesASCII.txt admin2Codes.txt`. Regeneration makes no client-data requests.
