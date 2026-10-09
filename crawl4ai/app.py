import asyncio
import base64
import ipaddress
import os
import socket
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, Field

TOKEN = os.environ["CRAWL4AI_TOKEN"]
EGRESS_PROXY = os.environ.get("EGRESS_PROXY", "http://127.0.0.1:7895")
MAX_CONCURRENCY = int(os.environ.get("CRAWL4AI_MAX_CONCURRENCY", "2"))
# Every render goes out through the shared egress proxy, and a long-lived Chromium
# context keeps its CONNECT socket pool open for minutes after a page finishes.
# A burst of renders therefore accumulates idle tunnels until the shared egress
# budget (EGRESS_MAX_CONNECTIONS) is exhausted, which then rejects the gateway's
# lightweight reads too. Recycling the browser context every N pages drops that
# pool and returns the budget to the whole gateway instead of holding it.
#
# Default 1 (recycle after every page). Crawl4AI 0.9.2 only bumps its browser
# version when `_pages_served >= N` is checked *after* the counter increments
# (browser_manager.py: `_should_recycle` / `_maybe_bump_browser_version`), and a
# bumped version is what queues the just-used context for close on release. Any
# N > 1 therefore leaves the trailing context of a batch un-queued until the next
# request crosses the threshold again: a *single* render (counter=1) never
# recycles at all, and an odd/partial tail keeps its tunnels. Measured on the
# isolated instance: one ft.com render at N=2 ends with 21-22 tunnels still held
# 30s later; at N=1 the same single render drains to 0. N=1 gives every page its
# own context, so the pool is always returned when the render finishes.
MAX_PAGES_BEFORE_RECYCLE = int(os.environ.get("CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE", "1"))
if MAX_PAGES_BEFORE_RECYCLE < 0:
    raise ValueError("CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE must be a non-negative integer")
DATA_DIR = os.environ["CRAWL4AI_DATA_DIR"]
semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
crawler: AsyncWebCrawler | None = None
crawler_lifecycle = "stopped"


class CrawlRequest(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=1)
    browser_config: dict = {}
    crawler_config: dict = {}


def public_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "only absolute http(s) URLs are allowed")
    try:
        records = socket.getaddrinfo(parsed.hostname, None, type=socket.SOCK_STREAM)
        addresses = {record[4][0] for record in records}
    except socket.gaierror as exc:
        raise HTTPException(400, "URL hostname could not be resolved") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise HTTPException(400, "private, loopback, link-local, and reserved addresses are blocked")
    return value


def check_token(authorization: str | None) -> None:
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "Bearer token required")


@asynccontextmanager
async def lifespan(_: FastAPI):
    global crawler, crawler_lifecycle
    crawler_lifecycle = "starting"
    instance = None
    try:
        browser = BrowserConfig(headless=True, verbose=False, proxy_config={"server": EGRESS_PROXY}, extra_args=["--disable-quic", "--disable-features=ServiceWorker"], max_pages_before_recycle=MAX_PAGES_BEFORE_RECYCLE)
        instance = AsyncWebCrawler(config=browser, base_directory=DATA_DIR, thread_safe=True)
        await instance.start()
        crawler = instance
        crawler_lifecycle = "ready"
        yield
    finally:
        crawler = None
        crawler_lifecycle = "stopping"
        try:
            if instance is not None:
                await instance.close()
        finally:
            crawler_lifecycle = "stopped"


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "concurrency": MAX_CONCURRENCY}


@app.get("/readyz")
async def readyz(response: Response, authorization: str | None = Header(default=None)):
    check_token(authorization)
    initialized = crawler is not None and crawler_lifecycle == "ready"
    response.status_code = 200 if initialized else 503
    return {"ok": initialized, "initialized": initialized, "lifecycle": crawler_lifecycle}


@app.post("/crawl")
async def crawl(request: CrawlRequest, authorization: str | None = Header(default=None)):
    check_token(authorization)
    url = public_url(request.urls[0])
    params = request.crawler_config.get("params", request.crawler_config)
    screenshot = bool(params.get("screenshot", False))
    pdf = bool(params.get("pdf", False))
    config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        screenshot=screenshot,
        pdf=pdf,
        page_timeout=60_000,
        word_count_threshold=1,
        remove_overlay_elements=True,
    )
    if crawler is None:
        raise HTTPException(503, "crawler is not ready")
    async with semaphore:
        try:
            result = await asyncio.wait_for(crawler.arun(url=url, config=config), timeout=90)
        except TimeoutError as exc:
            raise HTTPException(504, "Crawl4AI timed out") from exc
    if not result.success:
        raise HTTPException(502, result.error_message or "Crawl4AI failed")
    pdf_data = result.pdf
    if isinstance(pdf_data, bytes):
        pdf_data = base64.b64encode(pdf_data).decode("ascii")
    return {
        "results": [{
            "markdown": str(result.markdown or ""),
            "screenshot": result.screenshot,
            "pdf": pdf_data,
            "url": result.url,
        }]
    }
