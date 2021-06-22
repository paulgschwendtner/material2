/**
 * Script that renders the `universal-app` on the server and takes a screenshot of the
 * pre-rendered Angular application using a browser. The screenshot is then compared
 * against a golden file `/goldens/kitchen-sink-prerendered.png`.
 *
 * Screenshot testing server-side rendered components prevents us from silently regressing
 * with the visuals of pre-rendered components. Components should visually match as much
 * as possible with the hydrated components to avoid unexpected flashing.
 */

import {runfiles} from '@bazel/runfiles';
import {readFileSync, writeFileSync} from 'fs';
import {decode, encode, PNGDataArray} from 'fast-png';
import {join} from 'path';
import {launch, Page} from 'puppeteer-core';

const pixelmatch = require('pixelmatch');

/**
 * Metadata file generated by `rules_webtesting` for browser tests.
 * The metadata provides configuration for launching the browser and
 * necessary capabilities. See source for details:
 * https://github.com/bazelbuild/rules_webtesting/blob/06023bb3/web/internal/metadata.bzl#L69-L82
 */
interface WebTestMetadata {
  /**
   * List of web test files for the current browser. We limit our type to Chromium which
   * will be extracted at build time. More details on the properties:
   * https://github.com/bazelbuild/rules_webtesting/blob/34c659ab3e78f41ebe6453bee6201a69aef90f56/go/metadata/web_test_files.go#L29.
   */
  webTestFiles: {namedFiles: {CHROMIUM?: string}}[];
}

if (process.env['WEB_TEST_METADATA'] === undefined) {
  console.error(`Test running outside of a "web_test" target. No browser found.`);
  process.exit(1);
}

/** Web test metadata that has been registered as part of the Bazel `web_test`. */
const webTestMetadata: WebTestMetadata =
  require(runfiles.resolve(process.env['WEB_TEST_METADATA']));

/** Path to Chromium extracted from the Bazel `web_test` metadata. */
const chromiumExecutableRootPath = webTestMetadata.webTestFiles?.[0].namedFiles.CHROMIUM;

/** Path to a directory where undeclared test artifacts can be stored. e.g. a diff file. */
const testOutputDirectory = process.env.TEST_UNDECLARED_OUTPUTS_DIR!;

/** Path for a screenshot diff image that can be written. */
const screenshotDiffPath = join(testOutputDirectory, 'image-diff.png');

/** Width of the browser for the screenshot. */
const screenshotBrowserWidth = 1920;

if (require.main === module) {
  const args = process.argv.slice(2);
  const goldenPath = runfiles.resolveWorkspaceRelative(args[0]);
  const approveGolden = args[1] === 'true';

  main(goldenPath, approveGolden).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

/** Entry point for the screenshot test runner. */
async function main(goldenPath: string, approveGolden: boolean) {
  const outputPath = await renderKitchenSinkOnServer();
  const browser = await launch({
    executablePath: runfiles.resolve(chromiumExecutableRootPath!),
    headless: true,
  });

  const page = await browser.newPage();
  await page.goto(`file://${outputPath}`);
  await updateBrowserViewportToMatchContent(page);
  const currentScreenshotBuffer = await page.screenshot({encoding: 'binary'}) as Buffer;
  await browser.close();

  if (approveGolden) {
    writeFileSync(goldenPath, currentScreenshotBuffer);
    console.info('Golden screenshot updated.');
    return;
  }

  const currentScreenshot = decode(currentScreenshotBuffer);
  const goldenScreenshot = decode(readFileSync(goldenPath));
  const diffImageData: PNGDataArray = new Uint8Array({length: currentScreenshot.data.length});
  const numDiffPixels = pixelmatch(goldenScreenshot.data, currentScreenshot.data, diffImageData,
      currentScreenshot.width, currentScreenshot.height);

      console.error('diff perc', numDiffPixels / (currentScreenshot.width * currentScreenshot.height));

  if (numDiffPixels !== 0) {
    writeFileSync(screenshotDiffPath, encode({
      data: diffImageData,
      height: currentScreenshot.height,
      width: currentScreenshot.width
    }));

    console.error(`Expected golden image to match. ${numDiffPixels} pixels do not match.`);
    console.error(`Command to update the golden: yarn bazel run ${process.env.TEST_TARGET}.accept`);
    console.error(`See diff: file://${screenshotDiffPath.replace(/\\/g, '/')}`);
    process.exit(1);
  }

  console.info('Screenshot golden matches.');
}

/**
 * Renders the kitchen-sink app on the server.
 * @returns Path to the pre-rendered index HTML file.
 */
async function renderKitchenSinkOnServer(): Promise<string> {
  const {outputPath} = await import('./prerender');
  return outputPath;
}

/**
 * Updates the browser viewport to match the `body` content so that  everything
 * becomes visible without any scrollbars. This is useful for screenshots as it
 * allows Puppeteer to take full-page screenshots.
 */
async function updateBrowserViewportToMatchContent(page: Page) {
  const bodyScrollHeight = await page.evaluate(() => document.body.scrollHeight);
  // We use a hard-coded large width for the window, so that the screenshot does not become
  // too large vertically. This also helps with potential webdriver screenshot issues where
  // screenshots render incorrectly if the window height has been increased too much.
  await page.setViewport({
    width: screenshotBrowserWidth,
    height: bodyScrollHeight,
  });
}
