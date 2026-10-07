"""Run the production Crawl4AI API with an isolated renderer-boundary fixture.

The heavyweight Crawl4AI SDK is replaced, but BrowserConfig, app lifespan,
authentication, URL validation and /crawl handling execute the owned app. The
stand-in passes its configured proxy to real Chromium, never bypassing egress.
"""
import asyncio
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import socket
import sys
import types

import uvicorn

root = Path(__file__).resolve().parents[2]


class Config:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class Renderer:
    def __init__(self, config, **kwargs):
        self.config = config

    async def start(self):
        pass

    async def close(self):
        pass

    async def arun(self, url, config):
        process = await asyncio.create_subprocess_exec(
            os.environ["WAG_FIXTURE_NODE"], str(Path(__file__).with_name("render.mjs")),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        payload = {"url": url, "proxy": self.config.proxy_config["server"], "args": self.config.extra_args}
        output, error = await process.communicate(json.dumps(payload).encode())
        if process.returncode:
            raise RuntimeError(error.decode())
        return types.SimpleNamespace(**json.loads(output))


sdk = types.ModuleType("crawl4ai")
sdk.AsyncWebCrawler = Renderer
sdk.BrowserConfig = sdk.CrawlerRunConfig = Config
sdk.CacheMode = types.SimpleNamespace(BYPASS="bypass")
sys.modules["crawl4ai"] = sdk

original_lookup = socket.getaddrinfo
answers = {"navigation.test": "8.8.8.8", "redirect.test": "1.1.1.1", "asset.test": "9.9.9.9", "blocked.test": "127.0.0.1"}


def lookup(host, port, *args, **kwargs):
    if host in answers:
        host = answers[host]
    # No external DNS or general private-destination bypass in this harness.
    ipaddress.ip_address(host)
    return original_lookup(host, port, *args, **kwargs)


socket.getaddrinfo = lookup
spec = importlib.util.spec_from_file_location("owned_crawler", root / "crawl4ai" / "app.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class Server(uvicorn.Server):
    async def startup(self, sockets=None):
        await super().startup(sockets)
        print(json.dumps({"event": "crawler_fixture_listening", "port": self.config.port}), flush=True)


if __name__ == "__main__":
    Server(uvicorn.Config(app.app, host="127.0.0.1", port=int(os.environ["WAG_FIXTURE_PORT"]), log_level="error")).run()
