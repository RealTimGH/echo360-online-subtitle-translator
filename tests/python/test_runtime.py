import unittest
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from backend import app as backend
from backend import launcher
from backend import runtime
from translator import translate_vtt_zh_deepl_native as translator


SAMPLE_VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n"
SAMPLE_SRT = (
    "\ufeff1\r\n"
    "00:00:02,720 --> 00:00:06,590\r\n"
    "Note we're here. Example 00:00:01,234\r\n"
    "Second line\r\n\r\n"
    "2\r\n"
    "00:00:06,590 --> 00:00:10,730\r\n"
    "STYLE guide\r\n"
)
BILINGUAL_SAMPLE_VTT = "WEBVTT\n\n" + "\n\n".join(
    [
        f"00:00:0{index}.000 --> 00:00:0{index + 1}.000\n中文第 {index}\nEnglish line {index}"
        for index in range(3)
    ]
) + "\n"


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

    def test_server_rejects_non_loopback_listener_without_explicit_override(self):
        self.assertTrue(launcher.is_loopback_host("127.0.0.1"))
        self.assertTrue(launcher.is_loopback_host("::1"))
        self.assertFalse(launcher.is_loopback_host("0.0.0.0"))
        with mock.patch.object(launcher, "configure_runtime_environment"):
            with self.assertRaises(SystemExit):
                launcher.main(["--host", "0.0.0.0"])

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

    def test_request_model_rejects_unbounded_work_parameters(self):
        with self.assertRaises(ValueError):
            backend.TranslateRequest(vtt_text=SAMPLE_VTT, concurrency=257)
        with self.assertRaises(ValueError):
            backend.TranslateRequest(vtt_text=SAMPLE_VTT, retries=11)
        with self.assertRaises(ValueError):
            backend.TranslateRequest(vtt_text="x" * (backend.MAX_VTT_CHARS + 1))

    def test_vtt_validation_helpers_agree_on_a_minimal_document(self):
        self.assertEqual(backend.timed_cue_count(SAMPLE_VTT), 1)
        self.assertEqual(backend.translatable_line_count(SAMPLE_VTT), 1)
        self.assertEqual(backend.timed_cue_ranges(SAMPLE_VTT), [(0, 1000)])

    def test_backend_normalizes_numbered_srt_without_rewriting_caption_text(self):
        normalized = backend.normalize_timed_text(SAMPLE_SRT)
        self.assertEqual(
            normalized,
            "WEBVTT\n\n"
            "1\n"
            "00:00:02.720 --> 00:00:06.590\n"
            "Note we're here. Example 00:00:01,234\n"
            "Second line\n\n"
            "2\n"
            "00:00:06.590 --> 00:00:10.730\n"
            "STYLE guide",
        )
        self.assertTrue(backend.is_valid_timed_vtt(normalized))
        self.assertEqual(backend.timed_cue_count(normalized), 2)
        self.assertEqual(backend.timed_cue_ranges(normalized), [(2720, 6590), (6590, 10730)])
        self.assertEqual(
            [entry["text"] for entry in backend.timed_cue_text_entries(normalized)],
            [
                "Note we're here. Example 00:00:01,234",
                "Second line",
                "STYLE guide",
            ],
        )
        # Model construction is the shared boundary used by both HTTP routes,
        # so the async admission/progress count cannot observe raw SRT.
        self.assertEqual(backend.TranslateRequest(vtt_text=SAMPLE_SRT).vtt_text, normalized)

    def test_backend_leaves_transcript_and_malformed_srt_for_existing_source_guards(self):
        transcript = "Transcript --> explanation without timestamps"
        self.assertEqual(backend.normalize_timed_text(transcript), transcript)
        request = backend.TranslateRequest(vtt_text=transcript, provider="argos")
        with self.assertRaises(HTTPException) as caught:
            backend.run_translation(transcript, request, force_refresh=True)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(caught.exception.detail["error_code"], "INVALID_SOURCE_VTT")

        malformed_srt = (
            "1\n00:00:00,000 --> 00:00:01,000\n\n"
            "2\n00:00:01,000 --> 00:00:02,000\nCaption\n"
        )
        normalized = backend.normalize_timed_text(malformed_srt)
        self.assertTrue(backend.is_valid_timed_vtt(normalized))
        self.assertFalse(backend.has_timed_cue_text(normalized))
        request = backend.TranslateRequest(vtt_text=malformed_srt, provider="argos")
        with self.assertRaises(HTTPException) as caught:
            backend.run_translation(malformed_srt, request, force_refresh=True)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(caught.exception.detail["error_code"], "INVALID_SOURCE_VTT")

    def test_metadata_keywords_inside_cues_remain_caption_text(self):
        vtt = "\n".join([
            "WEBVTT",
            "",
            "NOTE document metadata",
            "metadata body",
            "",
            "STYLE",
            "::cue { color: white; }",
            "",
            "REGION",
            "id:main",
            "",
            "00:00:00.000 --> 00:00:01.000",
            "Note this is spoken text",
            "STYLE is also spoken text",
            "REGION appears in this caption",
            "WEBVTT is spoken text too",
            "",
        ])
        self.assertTrue(backend.has_timed_cue_text(vtt))
        self.assertEqual(backend.translatable_line_count(vtt), 4)
        self.assertEqual(
            translator.timed_text_line_indices(vtt.splitlines()),
            [12, 13, 14, 15],
        )

    def test_sync_and_async_entrypoints_pass_normalized_srt_to_translation(self):
        request = backend.TranslateRequest(vtt_text=SAMPLE_SRT, provider="argos")
        # Exercise the explicit route boundary as well as model construction;
        # older integrations can mutate/reuse a request object after parsing.
        request.vtt_text = SAMPLE_SRT
        fake_result = (SAMPLE_VTT, [], False, {"total": 1})
        with mock.patch.object(backend, "run_translation", return_value=fake_result) as run:
            backend.translate(request)
        self.assertEqual(run.call_args.args[0], request.vtt_text)
        self.assertTrue(run.call_args.args[0].startswith("WEBVTT\n\n1\n"))

        async_request = backend.TranslateAsyncRequest(vtt_text=SAMPLE_SRT, provider="argos")
        async_request.vtt_text = SAMPLE_SRT
        with mock.patch.object(backend.threading.Thread, "start"):
            created = backend.translate_async(async_request)
        try:
            job = backend.translate_async_status(created["job_id"])
            self.assertEqual(job["progress"]["total"], 3)
            self.assertTrue(async_request.vtt_text.startswith("WEBVTT\n\n1\n"))
        finally:
            with backend._jobs_lock:
                backend._jobs.pop(created["job_id"], None)

    def test_async_job_exposes_known_total_while_worker_is_preparing(self):
        request = backend.TranslateAsyncRequest(vtt_text=SAMPLE_VTT, provider="argos")
        with mock.patch.object(backend.threading.Thread, "start"):
            created = backend.translate_async(request)
        try:
            job = backend.translate_async_status(created["job_id"])
            self.assertEqual(job["status"], "queued")
            self.assertEqual(job["progress"]["current"], 0)
            self.assertEqual(job["progress"]["total"], 1)
            self.assertEqual(job["progress"]["stage"], "preparing")
        finally:
            with backend._jobs_lock:
                backend._jobs.pop(created["job_id"], None)

    def test_async_job_admission_rejects_unbounded_active_work(self):
        request = backend.TranslateAsyncRequest(vtt_text=SAMPLE_VTT, provider="argos")
        with backend._jobs_lock:
            original_jobs = dict(backend._jobs)
            backend._jobs.clear()
            backend._jobs.update({
                f"active-{index}": {
                    "status": "running",
                    "created_at": int(backend.time.time()),
                    "updated_at": int(backend.time.time()),
                }
                for index in range(backend.JOB_MAX_ACTIVE_COUNT)
            })
        try:
            with self.assertRaises(HTTPException) as caught:
                backend.translate_async(request)
            self.assertEqual(caught.exception.status_code, 429)
            self.assertEqual(caught.exception.detail["error_code"], "TOO_MANY_ACTIVE_JOBS")
        finally:
            with backend._jobs_lock:
                backend._jobs.clear()
                backend._jobs.update(original_jobs)

    def test_sync_translation_respects_the_global_process_limit(self):
        request = backend.TranslateRequest(vtt_text=SAMPLE_VTT, provider="argos")
        with mock.patch.object(backend._translation_slots, "acquire", return_value=False):
            with self.assertRaises(HTTPException) as caught:
                backend.translate(request)
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.detail["error_code"], "TOO_MANY_ACTIVE_JOBS")

    def test_async_worker_start_failure_becomes_a_terminal_job(self):
        request = backend.TranslateAsyncRequest(vtt_text=SAMPLE_VTT, provider="argos")
        fake_uuid = mock.Mock(hex="start-failure")
        try:
            with mock.patch.object(backend.uuid, "uuid4", return_value=fake_uuid), \
                    mock.patch.object(backend.threading.Thread, "start", side_effect=RuntimeError("no threads")):
                with self.assertRaises(HTTPException) as caught:
                    backend.translate_async(request)
            self.assertEqual(caught.exception.status_code, 503)
            snapshot = backend.translate_async_status("start-failure")
            self.assertEqual(snapshot["status"], "failed")
            self.assertEqual(snapshot["error_code"], "JOB_START_FAILED")
            self.assertEqual(snapshot["error_detail"]["error_code"], "JOB_START_FAILED")
        finally:
            with backend._jobs_lock:
                backend._jobs.pop("start-failure", None)

    def test_async_status_returns_an_isolated_snapshot(self):
        job_id = "snapshot-test"
        with backend._jobs_lock:
            backend._jobs[job_id] = {
                "status": "running",
                "progress": {"current": 1, "total": 2},
                "created_at": int(backend.time.time()),
                "updated_at": int(backend.time.time()),
            }
        try:
            snapshot = backend.translate_async_status(job_id)
            snapshot["progress"]["current"] = 99
            with backend._jobs_lock:
                self.assertEqual(backend._jobs[job_id]["progress"]["current"], 1)
        finally:
            with backend._jobs_lock:
                backend._jobs.pop(job_id, None)

    def test_target_coverage_accepts_neutral_unchanged_caption_but_not_ordinary_english(self):
        self.assertTrue(backend.is_target_neutral_text("F.", "F.", "ZH"))
        self.assertTrue(backend.is_target_neutral_text("2026", "2026", "ZH"))
        self.assertTrue(backend.is_target_neutral_text("ITLS6111", "ITLS6111", "ZH"))
        self.assertFalse(backend.is_target_neutral_text("unchanged", "unchanged", "ZH"))
        self.assertFalse(backend.is_target_neutral_text("F.", "F.", "EN"))
        neutral_vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nF.\n"
        self.assertTrue(backend.has_cjk_in_every_timed_cue(
            neutral_vtt,
            source_text=neutral_vtt,
            target="ZH",
        ))

    def test_bilingual_source_detector_blocks_accumulated_rendered_tracks(self):
        structure = backend.inspect_probable_bilingual_source(BILINGUAL_SAMPLE_VTT)
        self.assertTrue(structure["probable"])
        self.assertEqual(structure["cueCount"], 3)
        self.assertEqual(structure["mixedCueCount"], 3)
        self.assertEqual(structure["textLineCount"], 6)
        self.assertEqual(backend.translator_error_status("SOURCE_ALREADY_TRANSLATED"), 422)

        request = backend.TranslateRequest(
            vtt_text=BILINGUAL_SAMPLE_VTT,
            provider="argos",
            target="ZH",
        )
        with self.assertRaises(HTTPException) as caught:
            backend.run_translation(BILINGUAL_SAMPLE_VTT, request, force_refresh=True)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(caught.exception.detail["error_code"], "SOURCE_ALREADY_TRANSLATED")
        self.assertEqual(caught.exception.detail["details"]["sourceStructure"]["textLineCount"], 6)

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

    def test_translator_help_probe_has_a_hard_timeout(self):
        backend.get_supported_args.cache_clear()
        completed = mock.Mock(stdout="--progress-file", stderr="")
        try:
            with mock.patch.object(backend, "translator_runtime_available", return_value=True):
                with mock.patch.object(backend, "get_translator_command", return_value=["translator"]):
                    with mock.patch.object(backend.subprocess, "run", return_value=completed) as run:
                        self.assertEqual(backend.get_supported_args(), {"--progress-file"})
            run.assert_called_once_with(
                ["translator", "--help"],
                check=True,
                capture_output=True,
                text=True,
                timeout=backend.TRANSLATOR_HELP_TIMEOUT_SECONDS,
            )
        finally:
            backend.get_supported_args.cache_clear()

    def test_stubborn_translator_process_is_killed_after_grace_period(self):
        proc = mock.Mock()
        proc.poll.return_value = None
        proc.wait.side_effect = [subprocess.TimeoutExpired(cmd="translator", timeout=5), 0]
        backend.terminate_translator_process(proc)
        proc.terminate.assert_called_once_with()
        proc.kill.assert_called_once_with()
        self.assertEqual(proc.wait.call_count, 2)
        self.assertEqual(backend.translator_error_status("TRANSLATOR_PROCESS_TIMEOUT"), 504)

    @unittest.skipUnless(os.name == "posix", "POSIX-only process-group behavior")
    def test_posix_translator_process_group_is_terminated_and_reaped(self):
        proc = mock.Mock(pid=1234)
        proc.poll.return_value = None
        proc.wait.side_effect = [subprocess.TimeoutExpired(cmd="translator", timeout=5), 0]
        proc._echo360_process_group = "posix"
        with mock.patch.object(backend.os, "getpgid", return_value=1234), \
                mock.patch.object(backend.os, "killpg") as killpg:
            backend.terminate_translator_process(proc)
        self.assertEqual(
            killpg.call_args_list,
            [mock.call(1234, backend.signal.SIGTERM), mock.call(1234, backend.signal.SIGKILL)],
        )
        self.assertEqual(proc.wait.call_count, 2)

    def test_windows_translator_process_tree_is_terminated_and_reaped(self):
        proc = mock.Mock(pid=1234)
        proc.poll.return_value = None
        proc.wait.side_effect = [subprocess.TimeoutExpired(cmd="translator", timeout=5), 0]
        proc._echo360_process_group = "windows"
        with mock.patch.object(backend.subprocess, "run") as run:
            backend.terminate_translator_process(proc)
        proc.terminate.assert_called_once_with()
        run.assert_called_once_with(
            ["taskkill", "/PID", "1234", "/T", "/F"],
            check=False,
            capture_output=True,
            timeout=backend.TRANSLATOR_TERMINATE_GRACE_SECONDS,
        )
        self.assertEqual(proc.wait.call_count, 2)

    def test_translator_task_deadline_configuration_is_bounded(self):
        with mock.patch.dict(backend.os.environ, {"TEST_TASK_TIMEOUT": "480"}):
            self.assertEqual(backend.bounded_timeout_from_env("TEST_TASK_TIMEOUT", 120), 480)
        with mock.patch.dict(backend.os.environ, {"TEST_TASK_TIMEOUT": "5"}):
            self.assertEqual(backend.bounded_timeout_from_env("TEST_TASK_TIMEOUT", 120), 30)
        with mock.patch.dict(backend.os.environ, {"TEST_TASK_TIMEOUT": "90000"}):
            self.assertEqual(backend.bounded_timeout_from_env("TEST_TASK_TIMEOUT", 120), 480)
        with mock.patch.dict(backend.os.environ, {"TEST_TASK_TIMEOUT": "invalid"}):
            self.assertEqual(backend.bounded_timeout_from_env("TEST_TASK_TIMEOUT", 120), 120)

    def test_translator_output_reader_enforces_a_byte_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "translated.vtt"
            output.write_bytes(b"x" * 11)
            with mock.patch.object(backend, "MAX_TRANSLATOR_OUTPUT_BYTES", 10):
                with self.assertRaises(HTTPException) as caught:
                    backend.read_translator_output(output)
        self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(caught.exception.detail["error_code"], "TRANSLATOR_OUTPUT_TOO_LARGE")

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
    def test_batch_builder_rejects_a_single_line_that_exceeds_max_chars(self):
        with self.assertRaisesRegex(ValueError, "exceeds max_chars"):
            translator.build_text_batches(
                ["x" * 1201],
                [0],
                chunk_size=1,
                max_chars=1200,
            )

    def test_omitted_translator_provider_uses_google_web_defaults(self):
        defaults = translator.provider_defaults("")
        self.assertEqual(defaults["endpoint"], "")
        self.assertEqual(defaults["model"], "")
        self.assertEqual(defaults["concurrency"], 3)
        self.assertEqual(defaults["rps"], 3.0)

    def test_deepl_provider_applies_its_default_endpoint(self):
        self.assertEqual(
            translator.resolve_provider_endpoint("deepl"),
            "https://api-free.deepl.com/v2/translate",
        )

    def test_provider_endpoint_rejects_remote_plaintext_http(self):
        with self.assertRaisesRegex(ValueError, "must use HTTPS"):
            translator.resolve_provider_endpoint("openai", "http://translator.example/v1")
        self.assertEqual(
            translator.resolve_provider_endpoint("openai", "http://127.0.0.1:8080/v1"),
            "http://127.0.0.1:8080/v1",
        )

    def test_cli_reports_an_invalid_endpoint_as_a_typed_configuration_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "source.vtt"
            output = Path(tmpdir) / "translated.vtt"
            source.write_text(SAMPLE_VTT, encoding="utf-8")
            with mock.patch.object(sys, "argv", [
                "translator",
                str(source),
                "--out", str(output),
                "--provider", "openai",
                "--key", "dummy",
                "--endpoint", "http://translator.example/v1",
            ]), mock.patch("builtins.print") as print_mock:
                self.assertEqual(translator.main(), 1)
        output_lines = [" ".join(str(value) for value in call.args) for call in print_mock.call_args_list]
        self.assertTrue(any("ERROR_CODE: PROVIDER_CONFIG_ERROR" in line for line in output_lines))
        self.assertEqual(backend.translator_error_status("PROVIDER_CONFIG_ERROR"), 400)

    def test_cantonese_compatibility_alias_is_canonicalized(self):
        self.assertEqual(backend.normalize_target_code("cantonese"), "YUE")
        self.assertEqual(translator.normalize_target_code("cantonese"), "YUE")

    def test_translator_imports_and_exposes_expected_google_defaults(self):
        defaults = translator.provider_defaults("google-web")
        self.assertEqual(defaults["concurrency"], 3)
        self.assertEqual(backend.WEB_PROVIDER_LIMITS["google-web"]["concurrency"], 3)
        self.assertEqual(defaults["rps"], 3.0)
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

    def test_translator_source_detector_blocks_bilingual_input_before_provider_call(self):
        structure = translator.inspect_probable_bilingual_source(BILINGUAL_SAMPLE_VTT.splitlines())
        self.assertTrue(structure["probable"])
        self.assertEqual(structure["mixedCueCount"], 3)
        with self.assertRaisesRegex(ValueError, "SOURCE_ALREADY_TRANSLATED"):
            translator.translate_lines_native(
                BILINGUAL_SAMPLE_VTT.splitlines(),
                api_key="",
                provider="argos",
                target_lang="ZH",
                log_progress=False,
            )

    def test_argos_accepts_an_unchanged_neutral_caption_without_partial_failure(self):
        lines = [
            "WEBVTT",
            "",
            "00:00:00.000 --> 00:00:01.000",
            "F.",
            "",
        ]
        outcome = {}
        with mock.patch.object(translator, "argos_translate_batch", side_effect=lambda texts, target_lang: list(texts)):
            translated = translator.translate_lines_native(
                lines,
                api_key="",
                provider="argos",
                target_lang="ZH",
                concurrency=1,
                max_paragraphs=1,
                max_chars=1200,
                outcome_callback=outcome.update,
                log_progress=False,
            )
        self.assertEqual(translated, lines)
        self.assertEqual(outcome["failed"], 0)
        self.assertEqual(outcome["provider_results"], 1)
        self.assertEqual(outcome["target_results"], 1)
        self.assertEqual(outcome["unchanged_results"], 1)

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
