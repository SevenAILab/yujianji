# Admin-1 region data

`admin1-regions.json` is a simplified build of Natural Earth 1:10m “Admin 1 – States, Provinces” data (version 5.1.1). Natural Earth data is public domain.

Regenerate it with:

```bash
node scripts/build-admin1-regions.mjs path/to/ne_10m_admin_1_states_provinces.geojson src/data/admin1-regions.json
```

The generated file keeps ISO 3166-2 or Natural Earth region identifiers, names, representative centers, bounding boxes and simplified geometry. Boundaries are for product visualization and must not be used as a legal or political authority.
