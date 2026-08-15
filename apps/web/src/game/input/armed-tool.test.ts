// The armed-tool seam ([[065]]): what the renderer reads must move on the arming edge and
// hold still between them. What fails quietly: a publish that allocates or bumps `version`
// on every frame makes a consumer that diffs versions redraw the overlay sixty times a
// second — invisible in tests that only check the value, so the version discipline is the
// thing pinned here. One module-scope singleton, so these run as one ordered story.

import { describe, expect, it } from 'vitest';

import { armedTool, publishArmedTool } from './armed-tool';
import { ToolMode } from './tools';

describe('publishArmedTool', () => {
  it('publishes the tool and its held frame from the one shared table', () => {
    publishArmedTool(ToolMode.Water);
    expect(armedTool.tool).toBe(ToolMode.Water);
    expect(armedTool.heldFrame).toBe('tool_water');
  });

  it('a no-change publish bumps nothing — the per-frame safety net must be free', () => {
    publishArmedTool(ToolMode.Water);
    const version = armedTool.version;
    publishArmedTool(ToolMode.Water);
    publishArmedTool(ToolMode.Water);
    expect(armedTool.version).toBe(version);
  });

  it('the Hand arms with empty hands, and every change bumps the version once', () => {
    const before = armedTool.version;
    publishArmedTool(ToolMode.Hand);
    expect(armedTool.heldFrame).toBe('');
    expect(armedTool.version).toBe(before + 1);
  });
});
