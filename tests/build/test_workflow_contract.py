from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VALIDATE_WORKFLOW = ROOT / ".github" / "workflows" / "validate.yml"


class ValidationWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = VALIDATE_WORKFLOW.read_text(encoding="utf-8")

    def test_runs_on_main_push_without_a_disabled_pr_trigger(self) -> None:
        self.assertNotRegex(self.text, r"(?m)^  pull_request:$")
        self.assertRegex(self.text, r"(?m)^  push:$")
        self.assertIn("- main", self.text)
        self.assertIn("cancel-in-progress: true", self.text)

    def test_validation_actions_are_immutable_and_permissions_are_read_only(self) -> None:
        uses = re.findall(r"(?m)^\s*uses:\s*([^\s#]+)", self.text)
        self.assertTrue(uses)
        self.assertEqual(
            [value for value in uses if not re.fullmatch(r"[^@]+@[0-9a-f]{40}", value)],
            [],
        )
        self.assertRegex(self.text, r"(?ms)^permissions:\n  contents: read$")

    def test_runs_full_source_and_renderer_contracts(self) -> None:
        self.assertIn("unittest discover -s tests", self.text)
        self.assertIn("node tests/frontend/check_renderer_contract.js", self.text)
        self.assertIn("npm ci --ignore-scripts", self.text)

    def test_rejects_private_or_ignored_repository_files(self) -> None:
        self.assertIn("Verify repository hygiene", self.text)
        self.assertIn("python tests/build/verify_repository_hygiene.py", self.text)



if __name__ == "__main__":
    unittest.main()
