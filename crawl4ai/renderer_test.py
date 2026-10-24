import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

renderer_spec = importlib.util.spec_from_file_location(
    "fixture_renderer", Path(__file__).parents[1] / "proxy" / "fixtures" / "renderer.py"
)
renderer_module = importlib.util.module_from_spec(renderer_spec)
renderer_spec.loader.exec_module(renderer_module)
Renderer = renderer_module.Renderer


class FakeProcess:
    def __init__(self, *, output=b'{}', error=b'', returncode=None, fail_communicate=None):
        self.output = output
        self.error = error
        self.returncode = returncode
        self.fail_communicate = fail_communicate
        self.kill_calls = 0
        self.wait_calls = 0
        self.payload = None
        self.finished = asyncio.Event()
        if returncode is not None:
            self.finished.set()

    async def communicate(self, payload):
        self.payload = payload
        if self.fail_communicate is not None:
            raise self.fail_communicate
        await self.finished.wait()
        return self.output, self.error

    def kill(self):
        self.kill_calls += 1
        self.returncode = -9
        self.finished.set()

    async def wait(self):
        self.wait_calls += 1
        await self.finished.wait()
        return self.returncode


class RendererLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.renderer = Renderer(SimpleNamespace(
            proxy_config={"server": "http://127.0.0.1:1"},
            extra_args=[],
        ))

    async def install(self, process):
        created = asyncio.Event()

        async def create_process():
            created.set()
            return process

        self.renderer._create_process = create_process
        return created

    async def wait_for_active(self, process, created):
        await created.wait()
        while process not in self.renderer._active:
            await asyncio.sleep(0)

    async def test_success_unregisters_renderer_process(self):
        process = FakeProcess(
            output=json.dumps({"success": True, "markdown": "ok"}).encode(),
            returncode=0,
        )
        created = await self.install(process)

        result = await self.renderer.arun("https://example.test", None)

        self.assertTrue(result.success)
        self.assertEqual(process.kill_calls, 0)
        self.assertEqual(process.wait_calls, 0)
        self.assertNotIn(process, self.renderer._active)
        self.assertEqual(json.loads(process.payload)["url"], "https://example.test")
        self.assertTrue(created.is_set())

    async def test_nonzero_exit_is_reaped_and_unregistered(self):
        process = FakeProcess(error=b"renderer failed", returncode=1)
        await self.install(process)

        with self.assertRaisesRegex(RuntimeError, "renderer failed"):
            await self.renderer.arun("https://example.test", None)

        self.assertEqual(process.kill_calls, 0)
        self.assertEqual(process.wait_calls, 1)
        self.assertNotIn(process, self.renderer._active)

    async def test_communication_error_terminates_and_waits(self):
        process = FakeProcess(fail_communicate=RuntimeError("pipe failed"))
        await self.install(process)

        with self.assertRaisesRegex(RuntimeError, "pipe failed"):
            await self.renderer.arun("https://example.test", None)

        self.assertEqual(process.kill_calls, 1)
        self.assertEqual(process.wait_calls, 1)
        self.assertNotIn(process, self.renderer._active)

    async def test_cancellation_terminates_and_waits(self):
        process = FakeProcess()
        created = await self.install(process)
        task = asyncio.create_task(self.renderer.arun("https://example.test", None))
        await self.wait_for_active(process, created)

        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

        self.assertEqual(process.kill_calls, 1)
        self.assertEqual(process.wait_calls, 1)
        self.assertNotIn(process, self.renderer._active)

    async def test_cancellation_during_process_creation_reaps_after_handle_arrives(self):
        process = FakeProcess()
        creating = asyncio.Event()
        release = asyncio.Event()

        async def create_process():
            creating.set()
            await release.wait()
            return process

        self.renderer._create_process = create_process
        task = asyncio.create_task(self.renderer.arun("https://example.test", None))
        await creating.wait()
        task.cancel()
        await asyncio.sleep(0)
        release.set()

        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(process.kill_calls, 1)
        self.assertEqual(process.wait_calls, 1)
        self.assertNotIn(process, self.renderer._active)

    async def test_close_drains_active_renderer_processes(self):
        process = FakeProcess()
        created = await self.install(process)
        task = asyncio.create_task(self.renderer.arun("https://example.test", None))
        await self.wait_for_active(process, created)

        await self.renderer.close()
        with self.assertRaises(RuntimeError):
            await task
        await self.renderer.close()

        self.assertEqual(process.kill_calls, 1)
        self.assertEqual(process.wait_calls, 1)
        self.assertFalse(self.renderer._active)

    async def test_close_waits_for_process_creation(self):
        process = FakeProcess()
        creating = asyncio.Event()
        release = asyncio.Event()

        async def create_process():
            creating.set()
            await release.wait()
            return process

        self.renderer._create_process = create_process
        render_task = asyncio.create_task(self.renderer.arun("https://example.test", None))
        await creating.wait()
        close_task = asyncio.create_task(self.renderer.close())
        await asyncio.sleep(0)
        self.assertFalse(close_task.done())

        release.set()
        await close_task
        with self.assertRaises(RuntimeError):
            await render_task
        self.assertEqual(process.kill_calls, 1)
        self.assertEqual(process.wait_calls, 1)

    async def test_close_rejects_new_renderers(self):
        await self.renderer.close()

        with self.assertRaisesRegex(RuntimeError, "renderer is closed"):
            await self.renderer.arun("https://example.test", None)

    async def test_concurrent_cleanup_is_idempotent(self):
        process = FakeProcess()
        self.renderer._active.add(process)

        await asyncio.gather(
            self.renderer._reap(process),
            self.renderer._reap(process),
        )

        self.assertEqual(process.kill_calls, 1)
        self.assertEqual(process.wait_calls, 1)
        self.assertFalse(self.renderer._active)


if __name__ == "__main__":
    unittest.main()
