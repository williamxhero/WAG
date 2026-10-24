"""Owned renderer subprocess lifecycle for the crawler fixture."""
import asyncio
import json
import os
from pathlib import Path
import types


class Renderer:
    def __init__(self, config, **kwargs):
        self.config = config
        self._active = set()
        self._cleanup_tasks = {}
        self._closing = False
        self._state_lock = asyncio.Lock()

    async def start(self):
        self._closing = False

    async def _create_process(self):
        return await asyncio.create_subprocess_exec(
            os.environ["WAG_FIXTURE_NODE"], str(Path(__file__).with_name("render.mjs")),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

    async def _create_owned_process(self):
        creation = asyncio.create_task(self._create_process())
        try:
            return await asyncio.shield(creation)
        except asyncio.CancelledError:
            process = await asyncio.shield(creation)
            self._active.add(process)
            await self._reap(process)
            raise

    async def _terminate_and_wait(self, process):
        if process.returncode is None:
            process.kill()
        await process.wait()

    async def _reap(self, process):
        cleanup = self._cleanup_tasks.get(process)
        if cleanup is None:
            cleanup = asyncio.create_task(self._terminate_and_wait(process))
            self._cleanup_tasks[process] = cleanup
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            await asyncio.shield(cleanup)
            raise
        finally:
            if cleanup.done():
                self._cleanup_tasks.pop(process, None)
                self._active.discard(process)

    async def close(self):
        async with self._state_lock:
            self._closing = True
            processes = tuple(self._active)
        if not processes:
            return
        results = await asyncio.gather(
            *(self._reap(process) for process in processes),
            return_exceptions=True,
        )
        for result in results:
            if isinstance(result, BaseException):
                raise result

    async def arun(self, url, config):
        async with self._state_lock:
            if self._closing:
                raise RuntimeError("renderer is closed")
            process = await self._create_owned_process()
            self._active.add(process)
        try:
            payload = {"url": url, "proxy": self.config.proxy_config["server"], "args": self.config.extra_args}
            output, error = await process.communicate(json.dumps(payload).encode())
            if process.returncode:
                raise RuntimeError(error.decode())
            return types.SimpleNamespace(**json.loads(output))
        except BaseException:
            await self._reap(process)
            raise
        finally:
            self._active.discard(process)
