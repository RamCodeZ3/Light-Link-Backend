"""Verifica que los builds nunca acepten descargas truncadas o alteradas."""
import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment'))
from ensure_science import download


class Response(io.BytesIO):
    status=200


class DownloadTests(unittest.TestCase):
    def test_publishes_only_verified_file_and_reuses_cache(self):
        data=b'synthetic NASA download fixture'
        digest=hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'test.tif'
            with patch('ensure_science.urllib.request.urlopen',return_value=Response(data)) as request:
                download('https://example.invalid/test.tif',output,digest,100)
                self.assertEqual(output.read_bytes(),data)
                download('https://example.invalid/test.tif',output,digest,100)
                self.assertEqual(request.call_count,1)
                self.assertFalse(output.with_suffix('.tif.part').exists())

    def test_rejects_wrong_checksum_and_removes_partial_file(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'test.tif'
            with patch('ensure_science.urllib.request.urlopen',side_effect=lambda *a,**kw:Response(b'wrong')),patch('ensure_science.time.sleep'):
                with self.assertRaisesRegex(ValueError,'SHA-256'):
                    download('https://example.invalid/test.tif',output,'0'*64,100)
            self.assertFalse(output.exists())
            self.assertFalse(output.with_suffix('.tif.part').exists())

    def test_rejects_oversized_file(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'test.tif'
            with patch('ensure_science.urllib.request.urlopen',side_effect=lambda *a,**kw:Response(b'too large')),patch('ensure_science.time.sleep'):
                with self.assertRaisesRegex(ValueError,'tamaño'):
                    download('https://example.invalid/test.tif',output,'0'*64,2)
            self.assertFalse(output.exists())
            self.assertFalse(output.with_suffix('.tif.part').exists())
