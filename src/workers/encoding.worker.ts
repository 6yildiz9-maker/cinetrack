import { encodeItemContent, type ItemFeatureEncoding } from '../core/encoding.ts';

export interface WorkerTaskPayload {
  taskId: number;
  items: any[];
}

export interface WorkerTaskResponse {
  taskId: number;
  results: ItemFeatureEncoding[];
}

self.onmessage = (event: MessageEvent<WorkerTaskPayload>) => {
  const { taskId, items } = event.data || {};
  if (typeof taskId !== 'number' || !Array.isArray(items)) {
    return;
  }
  const results: ItemFeatureEncoding[] = items.map((item) => encodeItemContent(item));
  const response: WorkerTaskResponse = { taskId, results };
  self.postMessage(response);
};
