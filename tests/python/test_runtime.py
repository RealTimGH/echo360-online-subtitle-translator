import unittest
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import sys
import tempfile
from pathlib import Path
from unittest import mock

from backend import app as backend
from backend import launcher
from backend import runtime
from translator import translate_vtt_zh_deepl_native as translator


SAMPLE_VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n"


class BackendRuntimeTests(unittest.TestCase):
    def test_backend_protocol_url_is_parseable_and_removed_before_argparse(self):
        self.assertEqual(
            runtime.parse_backend_url(runtime.URL_SCHEME_START),
            {
                "scheme": runtime.URL_SCHEME,
                "action": "start",
                "url": runtime.URL_SCHEME_START,
            },
        )
        self.assertIsNone(runtime.parse_backend_url("https://example.test/start"))
        self.assertEqual(
            launcher.strip_protocol_url_args(
                ["--port", "9876", runtime.URL_SCHEME_START, "--log-level", "warning"]
            ),
            ["--port", "9876", "--log-level", "warning"],
        )

    def test_windows_url_scheme_registration_uses_hkcu_and_quotes_paths(self):
        calls = []

        class FakeKey:
            def __init__(self, path):
                self.path = path

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

        class FakeWinreg:
            HKEY_CURRENT_USER = "HKCU"
            KEY_WRITE = 0x20006
            REG_SZ = 1

            @staticmethod
            def CreateKeyEx(root, path, reserved, access):
                calls.append(("create", root, path, reserved, access))
                return FakeKey(path)

            @staticmethod
            def SetValueEx(key, name, reserved, value_type, value):
                calls.append(("set", key.path, name, reserved, value_type, value))

        executable = Path(tempfile.gettempdir()) / "Echo 360" / "echo360-subtitle-backend.exe"
        with mock.patch.object(runtime.platform, "system", return_value="Windows"):
            with mock.patch.dict(sys.modules, {"winreg": FakeWinreg}):
                self.assertTrue(runtime.register_windows_url_scheme(executable))

        create_paths = [item[2] for item in calls if item[0] == "create"]
        self.assertEqual(create_paths, [
            runtime.WINDOWS_URL_SCHEME_REGISTRY_PATH,
            runtime.WINDOWS_URL_SCHEME_REGISTRY_PATH + r"\shell\open\command",
        ])
        values = [item for item in calls if item[0] == "set"]
        self.assertIn(("set", runtime.WINDOWS_URL_SCHEME_REGISTRY_PATH, "URL Protocol", 0, 1, ""), values)
        command = next(
            item[-1]
            for item in values
            if item[1].endswith(r"\shell\open\command") and item[2] is None
        )
        self.assertIn("Echo 360", command)
        self.assertIn('"%1"', command)
        self.assertTrue(command.endswith(' "%1"'))

    def test_windows_install_script_is_safe_for_paths_with_spaces(self):
        script_path = Path(__file__).resolve().parents[2] / "scripts" / "build-backend.py"
        spec = importlib.util.spec_from_file_location("build_backend_for_test", script_path)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        with tempfile.TemporaryDirectory(prefix="Echo 360 package ") as package_dir:
            generated = module.write_windows_install_script(Path(package_dir))
            text = generated.read_bytes().decode("utf-8")
        self.assertIn('set "BACKEND_EXE=%~dp0echo360-subtitle-backend.exe"', text)
        self.assertIn('"%BACKEND_EXE%" --register-url-scheme', text)
        self.assertIn('start "" "%BACKEND_EXE%" "%BACKEND_URL%"', text)

    def test_normal_server_start_repairs_windows_url_registration_after_stripping_uri(self):
        with mock.patch.object(launcher, "configure_runtime_environment"), \
                mock.patch.object(launcher, "register_windows_url_scheme") as register, \
                mock.patch("uvicorn.run") as uvicorn_run:
            self.assertEqual(
                launcher.main([runtime.URL_SCHEME_START, "--port", "9876", "--log-level", "warning"]),
                0,
            )
        register.assert_called_once_with()
        uvicorn_run.assert_called_once()
        self.assertEqual(uvicorn_run.call_args.kwargs["port"], 9876)

    def test_register_url_scheme_flag_exits_without_starting_server(self):
        with mock.patch.object(launcher, "configure_runtime_environment") as configure, \
                mock.patch.object(launcher, "register_windows_url_scheme", return_value=True), \
                mock.patch.object(launcher.platform, "system", return_value="Windows"):
            self.assertEqual(launcher.main([launcher.REGISTER_URL_SCHEME_MODE]), 0)
        configure.assert_not_called()

    def test_backend_imports_and_registers_public_routes(self):
        self.assertEqual(backend.health(), {"ok": True})
        paths = {route.path for route in backend.app.routes}
        self.assertTrue({"/health", "/translate", "/translate-async", "/translate-async/{job_id}"} <= paths)

    def test_request_model_is_constructible_on_supported_python(self):
        request = backend.TranslateRequest(vtt_text=SAMPLE_VTT)
        self.assertEqual(request.provider, "google-web")
        self.assertEqual(request.model, "")
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
        self.assertEqual(
            backend.no_result_failure_code(
                "google-web", "ZH", {"ARGOS_MODEL_MISSING": 2}, 2, 0, 0
            ),
            "ARGOS_MODEL_MISSING",
        )

    def test_source_backend_invokes_the_translator_through_python(self):
        command = backend.get_translator_command()
        self.assertEqual(command[0], backend.get_translator_python())
        self.assertEqual(command[1], str(backend.TRANSLATOR_SCRIPT))

    def test_frozen_backend_dispatches_translation_through_its_own_executable(self):
        with mock.patch.object(sys, "frozen", True, create=True):
            self.assertEqual(backend.get_translator_command(), [sys.executable, "--translator"])
            self.assertTrue(backend.translator_runtime_available())

    def test_backend_passes_api_key_only_through_the_child_environment(self):
        request = backend.TranslateRequest(vtt_text=SAMPLE_VTT, api_key="secret-value")
        args = backend.build_translator_args(
            Path("input.vtt"),
            Path("output.vtt"),
            request,
            set(),
            [],
        )
        self.assertNotIn("--key", args)
        self.assertNotIn("secret-value", args)

    def test_provider_limit_notes_are_not_reported_as_translation_warnings(self):
        for provider in ("google-web", "argos"):
            warnings = []
            request = backend.TranslateRequest(vtt_text=SAMPLE_VTT, provider=provider)
            backend.build_translator_args(
                Path("input.vtt"),
                Path("output.vtt"),
                request,
                set(),
                warnings,
            )
            self.assertEqual(warnings, [], provider)


class TranslatorRuntimeTests(unittest.TestCase):
    def test_omitted_translator_provider_uses_google_web_defaults(self):
        defaults = translator.provider_defaults("")
        self.assertEqual(defaults["endpoint"], "")
        self.assertEqual(defaults["model"], "")
        self.assertEqual(defaults["concurrency"], 48)

    def test_translator_imports_and_exposes_expected_google_defaults(self):
        defaults = translator.provider_defaults("google-web")
        self.assertEqual(defaults["concurrency"], 48)
        self.assertEqual(backend.WEB_PROVIDER_LIMITS["google-web"]["concurrency"], 48)
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

    def test_progress_snapshot_retries_a_transient_windows_replace_lock(self):
        with tempfile.TemporaryDirectory(prefix="echo360-progress-") as tmpdir:
            progress_path = Path(tmpdir) / "progress.vtt"
            real_replace = translator.os.replace
            calls = {"count": 0}

            def replace_with_transient_lock(source, target):
                calls["count"] += 1
                if calls["count"] == 1:
                    raise PermissionError(13, "Access is denied")
                return real_replace(source, target)

            with mock.patch.object(translator.os, "replace", side_effect=replace_with_transient_lock):
                translator.write_progress_snapshot(progress_path, ["WEBVTT", "", "translated"])

            self.assertEqual(calls["count"], 2)
            self.assertEqual(progress_path.read_text(encoding="utf-8"), "WEBVTT\n\ntranslated")
            self.assertEqual(list(Path(tmpdir).glob(".progress.vtt.*.tmp")), [])


class GoogleArgosFallbackTests(unittest.TestCase):
    @staticmethod
    def _response(status: int, payload=None):
        response = mock.Mock()
        response.status_code = status
        response.headers = {}
        if payload is not None:
            response.json.return_value = payload
        return response

    @staticmethod
    def _vtt(count: int) -> str:
        lines = ["WEBVTT", ""]
        for index in range(count):
            lines.extend([
                f"00:00:{index:02d}.000 --> 00:00:{index + 1:02d}.000",
                f"cue-{index}",
                "",
            ])
        return "\n".join(lines)

    def test_google_rate_limit_circuit_is_thread_safe_and_short_windowed(self):
        circuit = translator.GoogleWebRateLimitCircuit(threshold=5, window_seconds=10)
        with ThreadPoolExecutor(max_workers=8) as executor:
            opened = list(executor.map(lambda _index: circuit.record_429(), range(20)))

        self.assertTrue(any(opened))
        self.assertTrue(circuit.is_open())
        self.assertEqual(circuit.total_429_responses, 20)
        with self.assertRaises(translator.GoogleWebRateLimitCircuitOpen):
            circuit.raise_if_open()

    def test_google_stops_after_five_429s_and_repairs_only_unresolved_cues_with_argos(self):
        google_calls = []

        def google_get(_session, url, **kwargs):
            google_calls.append(url)
            index = len(google_calls) - 1
            if index < 2:
                return self._response(200, [[[f"谷歌-{index}", f"cue-{index}"]]])
            return self._response(429)

        argos_translate = mock.Mock(
            side_effect=lambda texts, target_lang: [f"阿尔戈斯-{text}" for text in texts]
        )
        outcome = {}
        with (
            mock.patch.object(translator.requests.Session, "get", autospec=True, side_effect=google_get),
            mock.patch.object(translator, "argos_translate_batch", argos_translate),
        ):
            translated_lines = translator.translate_lines_native(
                self._vtt(7).splitlines(),
                api_key="",
                provider="google-web",
                target_lang="ZH",
                concurrency=1,
                max_paragraphs=1,
                max_chars=1200,
                max_retries=0,
                outcome_callback=outcome.update,
                log_progress=False,
            )

        # Two Google successes plus exactly five 429 responses. No eighth cue
        # request is made after the fifth response opens the circuit.
        self.assertEqual(len(google_calls), 7)
        self.assertEqual(argos_translate.call_count, 1)
        self.assertEqual(argos_translate.call_args.args[0], [
            "cue-2", "cue-3", "cue-4", "cue-5", "cue-6",
        ])
        self.assertIn("谷歌-0", "\n".join(translated_lines))
        self.assertIn("谷歌-1", "\n".join(translated_lines))
        self.assertEqual(sum("阿尔戈斯-" in line for line in translated_lines), 5)
        self.assertEqual(outcome["google429Responses"], 5)
        self.assertTrue(outcome["googleCircuitTripped"])
        self.assertEqual(outcome["fallback_provider"], "argos")
        self.assertEqual(outcome["fallback_provider_results"], 5)
        self.assertEqual(outcome["processed"], 7)
        self.assertEqual(outcome["translated"], 7)
        self.assertEqual(outcome["provider_results"], 7)
        self.assertEqual(outcome["failed"], 0)
        self.assertEqual(outcome["failed_items"], [])

    def test_unsupported_argos_target_does_not_trigger_fallback(self):
        google_calls = []

        def google_get(_session, url, **kwargs):
            google_calls.append(url)
            return self._response(429)

        argos_translate = mock.Mock()
        outcome = {}
        with (
            mock.patch.object(translator.requests.Session, "get", autospec=True, side_effect=google_get),
            mock.patch.object(translator, "argos_translate_batch", argos_translate),
        ):
            translated_lines = translator.translate_lines_native(
                self._vtt(6).splitlines(),
                api_key="",
                provider="google-web",
                target_lang="YUE",
                concurrency=1,
                max_paragraphs=1,
                max_chars=1200,
                max_retries=0,
                outcome_callback=outcome.update,
                log_progress=False,
            )

        self.assertEqual(len(google_calls), 5)
        argos_translate.assert_not_called()
        self.assertEqual(outcome["google429Responses"], 5)
        self.assertTrue(outcome["googleCircuitTripped"])
        self.assertIsNone(outcome["fallback_provider"])
        self.assertEqual(outcome["fallback_provider_results"], 0)
        self.assertEqual(outcome["processed"], 6)
        self.assertEqual(outcome["translated"], 0)
        self.assertEqual(outcome["provider_results"], 0)
        self.assertEqual(outcome["failed"], 6)
        self.assertEqual(sum(line.startswith("cue-") for line in translated_lines), 6)


if __name__ == "__main__":
    unittest.main()
