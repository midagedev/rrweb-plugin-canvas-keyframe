import type { recordOptions } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import { getRecordCanvasKeyframePlugin } from '../src/index';

// Compile-time check: the plugin is accepted where rrweb expects a record plugin.
export const options: recordOptions<eventWithTime> = {
  plugins: [getRecordCanvasKeyframePlugin({ maxEdge: 640 })],
};
