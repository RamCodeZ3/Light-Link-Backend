"""Pruebas sintéticas: no representan resultados científicos reales."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python'))
from analyse_site import AnalysisError, parse_horizons, terrain, utc_date


def document(rows=None):
    return {'result': '''Center body name: Moon (301) {source: TEST}
Center geodetic : 0.000000, -89.000000, 0.00200
Center pole/equ : MEAN_ME (synthetic fixture)
Center radii : 1737.4, 1737.4, 1737.4 km
$$SOE
'''+(rows if rows is not None else '2026-Nov-14 00:00,*, , 264.152309, 1.502447,\n2026-Nov-14 01:00,*, , 263.644478, 1.497768,\n')+'$$EOE'}


class HorizonsTests(unittest.TestCase):
    def setUp(self):
        self.start = utc_date('2026-11-14T00:00:00Z')
        self.end = utc_date('2026-11-14T01:00:00Z')

    def parse(self, doc):
        return parse_horizons(doc, -89, 0, .002, self.start, self.end)

    def test_parses_utc_and_angles(self):
        rows = self.parse(document())
        self.assertEqual(rows[0]['timestamp_utc'], '2026-11-14T00:00:00Z')
        self.assertEqual(rows[0]['elevation_deg'], 1.502447)

    def test_rejects_wrong_body_frame_coordinates_and_altitude(self):
        for before, after in [('Moon (301)', 'Earth (399)'), ('MEAN_ME', 'IAU'), ('0.000000, -89.000000', '1.000000, -89.000000'), ('0.00200', '2.00000'), ('1737.4, 1737.4, 1737.4', '6378.1, 6378.1, 6378.1')]:
            with self.subTest(after=after), self.assertRaises(AnalysisError):
                self.parse({'result': document()['result'].replace(before, after)})

    def test_rejects_missing_duplicate_or_nonfinite_rows(self):
        row = '2026-Nov-14 00:00,*, , 264.152309, 1.502447,\n'
        for rows in [row, row+row, row+row.replace('00:00', '01:00').replace('1.502447', 'NaN')]:
            with self.subTest(rows=rows), self.assertRaises(AnalysisError):
                self.parse(document(rows))

    def test_rejects_api_error(self):
        with self.assertRaises(AnalysisError):
            self.parse({'error': 'query failed'})

    def test_invalid_dates(self):
        for date in ['2026-02-30T00:00:00Z', '2026-11-14T00:30:00Z']:
            with self.assertRaises(AnalysisError):
                utc_date(date)


class TerrainTests(unittest.TestCase):
    def test_flat_synthetic_lunar_dem_and_coverage(self):
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin
        from comun import latlon_to_polar_stereographic
        x, y = map(float, latlon_to_polar_stereographic(-89, 0))
        crs = '+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400 +units=m +no_defs'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            near = root/'Test_final_adj_5mpp_surf.tif'
            far = root/'regional.tif'
            for path, size, resolution in [(near, 200, 5), (far, 400, 1000)]:
                data = np.zeros((size, size), dtype='float32')
                with rasterio.open(path, 'w', driver='GTiff', width=size, height=size, count=1, dtype='float32', crs=crs, transform=from_origin(x-size*resolution/2, y+size*resolution/2, resolution, resolution), nodata=-9999) as ds:
                    ds.write(data, 1)
            generated = terrain(-89, 0, 2, root, far)
            self.assertEqual(len(generated['horizon']), 360)
            self.assertTrue(all(np.isfinite(generated['horizon'])))
            self.assertTrue(all(h < 0 for h in generated['horizon']))
            from math import acos, degrees
            expected = -degrees(acos(1737400 / (1737400+2)))
            self.assertTrue(all(abs(h-expected) < 0.001 for h in generated['horizon']))
            self.assertEqual(generated['ground'], 0)
            self.assertEqual(generated['png'][24], 16)
            self.assertLess(len(generated['png']), 1500000)
            with self.assertRaises(AnalysisError):
                terrain(-85, 0, 2, root, far)
            with rasterio.open(near, 'r+') as ds:
                data=ds.read(1);data[99:102, 99:102]=-9999;ds.write(data,1)
            with self.assertRaises(AnalysisError):
                terrain(-89, 0, 2, root, far)


if __name__ == '__main__':
    unittest.main()
