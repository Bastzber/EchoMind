from __future__ import annotations

from pathlib import Path
import sys
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.noise_ambience import STEM_MIX, is_servable_stem_name


class StemNameTest(unittest.TestCase):
    def test_forest_regression(self):
        """回归：白名单漏了 forest，林间鸟鸣四条音轨全被 400，前端表现为静音。"""
        self.assertTrue(is_servable_stem_name("forest_drops.wav"))

    def test_every_synth_kind_is_servable(self):
        """STEM_MIX 里有几种环境音，就必须能取到几种。"""
        for kind, mix in STEM_MIX.items():
            for stem_id in mix:
                with self.subTest(kind=kind, stem=stem_id):
                    self.assertTrue(is_servable_stem_name(f"{kind}_{stem_id}.wav"))

    def test_user_stem_names_are_servable(self):
        """用户自备素材固定按 STEM_ORDER 命名，跟配方自身的音轨名不一定一致。"""
        for kind in STEM_MIX:
            for stem_id in ("base", "mid", "drops", "accent"):
                with self.subTest(kind=kind, stem=stem_id):
                    self.assertTrue(is_servable_stem_name(f"{kind}_{stem_id}.wav"))

    def test_rejects_unknown_kind(self):
        self.assertFalse(is_servable_stem_name("volcano_base.wav"))

    def test_rejects_unknown_stem(self):
        self.assertFalse(is_servable_stem_name("forest_nope.wav"))

    def test_rejects_traversal_and_other_names(self):
        for name in (
            "../forest_base.wav",
            "forest_base.wav.exe",
            "forest_base.wav/..",
            "forest_base.mp3",
            "forest_base.wav ",
            "FOREST_base.wav",
            "",
            "forest_base",
        ):
            with self.subTest(name=name):
                self.assertFalse(is_servable_stem_name(name))


if __name__ == "__main__":
    unittest.main()
