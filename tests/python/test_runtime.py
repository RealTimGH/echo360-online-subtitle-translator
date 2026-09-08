import unittest
from unittest import mock

from backend import app as backend
from translator import translate_vtt_zh_deepl_native as translator


SAMPLE_VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n"


class BackendRuntimeTests(unittest.TestCase):
    def test_backend_imports_and_registers_public_routes(self):
        self.assertEqual(backend.health(), {"ok": True})
        paths = {route.path for route in backend.app.routes}
        self.assertTrue({"/health", "/translate", "/translate-async", "/translate-async/{job_id}"} <= paths)

    def test_request_model_is_constructible_on_supported_python(self):
        request = backend.TranslateRequest(vtt_text=SAMPLE_VTT)
        self.assertEqual(request.provider, "deepseek")
        self.assertIsNone(request.timeout)
        self.assertIsNone(request.reasoning_effort)

    def test_vtt_validation_helpers_agree_on_a_minimal_document(self):
        self.assertEqual(backend.timed_cue_count(SAMPLE_VTT), 1)
        self.assertEqual(backend.translatable_line_count(SAMPLE_VTT), 1)
        self.assertEqual(backend.timed_cue_ranges(SAMPLE_VTT), [(0, 1000)])

    def test_problem_payload_redacts_credentials_and_preserves_typed_status(self):
        problem = backend.problem_payload(
            429,
            "HTTP_429",
            "api_key=sk-secretvalue123",
            retryable=True,
        )
        self.assertEqual(problem["status"], 429)
        self.assertEqual(problem["error_code"], "HTTP_429")
        self.assertEqual(problem["detail"], "api_key=[REDACTED]")
        self.assertTrue(problem["retryable"])

    def test_local_backend_rejects_unrelated_browser_origins(self):
        allowed = [
            "chrome-extension://abcdefghijklmnop",
            "safari-web-extension://com.example.echo360",
            "https://canvas.sydney.edu.au",
            "https://sydney.instructuremedia.com",
            "https://learn.echo360.net.au",
            "http://127.0.0.1:3000",
        ]
        rejected = [
            "https://attacker.example",
            "https://echo360.net.au.attacker.example",
            "null",
            "file://",
            "",
        ]
        self.assertTrue(all(backend.is_allowed_browser_origin(origin) for origin in allowed))
        self.assertFalse(any(backend.is_allowed_browser_origin(origin) for origin in rejected))

    def test_argos_is_keyless_but_has_local_runtime_limits(self):
        self.assertIn("argos", backend.KEYLESS_PROVIDERS)
        self.assertEqual(backend.WEB_PROVIDER_LIMITS["argos"]["concurrency"], 1)
        self.assertEqual(backend.translator_error_status("ARGOS_MODEL_MISSING"), 503)
        self.assertEqual(
            backend.no_result_failure_code(
                "argos", "ZH", {"ARGOS_MODEL_MISSING": 2}, 2, 0, 0
            ),
            "ARGOS_MODEL_MISSING",
        )


class TranslatorRuntimeTests(unittest.TestCase):
    def test_translator_imports_and_exposes_expected_google_defaults(self):
        defaults = translator.provider_defaults("google-web")
        self.assertEqual(defaults["concurrency"], 96)
        self.assertEqual(defaults["rps"], 0.0)
        self.assertEqual(defaults["max_paragraphs"], 1)

    def test_cli_error_code_normalization_keeps_specific_diagnostics(self):
        self.assertEqual(translator._normalize_cli_error_code("http 429"), "HTTP_429")
        self.assertEqual(translator._error_code_from_text("request timed out"), "REQUEST_TIMEOUT")

    def test_argos_defaults_are_serial_and_keyless(self):
        defaults = translator.provider_defaults("argos")
        self.assertEqual(defaults["concurrency"], 1)
        self.assertEqual(defaults["max_retries"], 0)
        self.assertIn("argos", translator.KEYLESS_PROVIDERS)

    def test_argos_target_mapping_is_explicit(self):
        self.assertEqual(translator._resolve_argos_target_lang("ZH"), "zh")
        self.assertEqual(translator._resolve_argos_target_lang("zh-hk"), "zt")
        with self.assertRaisesRegex(ValueError, "UNSUPPORTED_TARGET_LANGUAGE"):
            translator._resolve_argos_target_lang("YUE")
        with self.assertRaisesRegex(ValueError, "English as its source"):
            translator._resolve_argos_target_lang("EN")

    def test_argos_batch_uses_an_installed_translation_without_network(self):
        class FakeTranslation:
            def translate(self, text):
                return f"译:{text}"

        class FakeLanguage:
            def __init__(self, code):
                self.code = code

            def get_translation(self, target):
                return FakeTranslation() if self.code == "en" and target.code == "zh" else None

        fake_module = mock.Mock()
        fake_module.get_installed_languages.return_value = [FakeLanguage("en"), FakeLanguage("zh")]
        with mock.patch.object(translator, "_load_argos_translate_module", return_value=fake_module):
            self.assertEqual(translator.argos_translate_batch(["Hello", "Class"], "ZH"), ["译:Hello", "译:Class"])

    def test_argos_missing_model_has_an_actionable_error(self):
        fake_module = mock.Mock()
        fake_module.get_installed_languages.return_value = []
        with mock.patch.object(translator, "_load_argos_translate_module", return_value=fake_module):
            with self.assertRaisesRegex(RuntimeError, "argospm install translate-en_zh"):
                translator.argos_translate_batch(["Hello"], "ZH")


if __name__ == "__main__":
    unittest.main()
