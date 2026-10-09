"""Offline lifecycle fixtures: no crawler/browser or Python dependency provisioning."""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code
        self.detail = detail


class FastAPI:
    def __init__(self, **kwargs):
        self.routes = {}

    def get(self, path):
        return lambda handler: self.routes.setdefault(("GET", path), handler)

    def post(self, path):
        return lambda handler: self.routes.setdefault(("POST", path), handler)


class Crawler:
    starts = 0
    crawls = 0
    fail_start = False
    last_config = None

    def __init__(self, **kwargs):
        self.closed = False
        Crawler.last_config = kwargs.get("config")

    async def start(self):
        Crawler.starts += 1
        if Crawler.fail_start:
            raise RuntimeError("offline initialization failure")

    async def close(self):
        self.closed = True

    async def arun(self, **kwargs):
        Crawler.crawls += 1
        raise AssertionError("readiness must not crawl")


def load_app(env=None):
    crawler = types.ModuleType("crawl4ai")
    crawler.AsyncWebCrawler = Crawler
    crawler.BrowserConfig = crawler.CrawlerRunConfig = lambda **kwargs: kwargs
    crawler.CacheMode = types.SimpleNamespace(BYPASS="bypass")
    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI = FastAPI
    fastapi.Header = lambda **kwargs: None
    fastapi.HTTPException = HTTPException
    fastapi.Response = lambda **kwargs: types.SimpleNamespace(**kwargs)
    pydantic = types.ModuleType("pydantic")
    pydantic.BaseModel = object
    pydantic.Field = lambda **kwargs: None
    spec = importlib.util.spec_from_file_location("offline_crawler_app", Path(__file__).with_name("app.py"))
    app = importlib.util.module_from_spec(spec)
    environment = {"CRAWL4AI_TOKEN": "offline-test-token", "CRAWL4AI_DATA_DIR": "/offline", **(env or {})}
    with patch.dict(sys.modules, {"crawl4ai": crawler, "fastapi": fastapi, "pydantic": pydantic}), patch.dict(os.environ, environment):
        spec.loader.exec_module(app)
    return app


class HealthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        Crawler.starts = Crawler.crawls = 0
        Crawler.fail_start = False
        Crawler.last_config = None
        self.module = load_app()

    async def test_failed_start_never_publishes_an_initialized_crawler(self):
        Crawler.fail_start = True
        with self.assertRaisesRegex(RuntimeError, "initialization failure"):
            async with self.module.lifespan(self.module.app):
                self.fail("failed start must not enter serving lifecycle")
        response = types.SimpleNamespace(status_code=200)
        ready = await self.module.readyz(response, "Bearer offline-test-token")
        self.assertEqual(ready, {"ok": False, "initialized": False, "lifecycle": "stopped"})
        self.assertEqual(response.status_code, 503)
        self.assertIsNone(self.module.crawler)
        self.assertEqual(Crawler.crawls, 0)

    async def test_readiness_is_authenticated_and_liveness_remains_cheap(self):
        for authorization in (None, "Bearer incorrect"):
            with self.assertRaises(HTTPException) as failure:
                await self.module.readyz(types.SimpleNamespace(status_code=200), authorization)
            self.assertEqual(failure.exception.status_code, 401)
        for _ in range(3):
            self.assertEqual((await self.module.healthz())["status"], "ok")
        self.assertEqual(Crawler.starts, 0)
        self.assertEqual(Crawler.crawls, 0)

    async def test_readiness_requires_successful_initialization_and_clears_on_shutdown(self):
        module = self.module
        ready = module.app.routes[("GET", "/readyz")]
        response = types.SimpleNamespace(status_code=200)
        self.assertEqual(await module.healthz(), {"status": "ok", "concurrency": 2})
        self.assertEqual((await ready(response, "Bearer offline-test-token"))["initialized"], False)
        self.assertEqual(response.status_code, 503)
        async with module.lifespan(module.app):
            response.status_code = 200
            self.assertEqual(await ready(response, "Bearer offline-test-token"), {"ok": True, "initialized": True, "lifecycle": "ready"})
            instance = module.crawler
        self.assertTrue(instance.closed)
        self.assertEqual((await ready(response, "Bearer offline-test-token"))["initialized"], False)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(Crawler.starts, 1)
        self.assertEqual(Crawler.crawls, 0)

    async def test_browser_recycles_its_context_after_a_bounded_number_of_pages(self):
        # A long-lived browser context keeps its CONNECT socket pool open for
        # minutes, so a burst of renders can hold the whole shared egress budget
        # and starve the gateway's lightweight reads. Recycling the context every
        # N pages releases that pool; the setting must reach BrowserConfig.
        #
        # The default is 1 (recycle after every page): Crawl4AI 0.9.2 only queues a
        # context for close when the per-page counter reaches the threshold, so any
        # N > 1 leaves the trailing context of a batch alive (a single render at N=2
        # never recycles at all). N=1 gives each page its own context so the pool is
        # always returned when that render finishes.
        for env, expected in [({}, 1), ({"CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE": "2"}, 2), ({"CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE": "8"}, 8)]:
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE", None)
                os.environ.update(env)
                module = load_app()
                async with module.lifespan(module.app):
                    self.assertEqual(module.MAX_PAGES_BEFORE_RECYCLE, expected)
                    self.assertEqual(Crawler.last_config["max_pages_before_recycle"], expected)

    async def test_an_invalid_recycle_setting_is_rejected(self):
        with patch.dict(os.environ, {"CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE": "-1"}, clear=False):
            with self.assertRaisesRegex(ValueError, "CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE"):
                load_app()


if __name__ == "__main__":
    unittest.main()
