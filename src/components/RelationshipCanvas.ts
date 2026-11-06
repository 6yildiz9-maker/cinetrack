import type { RelationshipGraphNode } from '../core/relationship-explorer.ts';
import { getRelationshipNodeColor } from '../core/relationship-wordlists.ts';

export function renderRelationshipCanvasNode(
  rawNode: unknown,
  ctx: CanvasRenderingContext2D,
  globalScale: number,
  selectedNodeId?: string,
): void {
  if (!rawNode || typeof rawNode !== 'object' || !ctx) return;
  const node = rawNode as RelationshipGraphNode & { x?: number; y?: number };
  const rawX = Number(node.x);
  const rawY = Number(node.y);
  const x = Number.isFinite(rawX) ? rawX : 0;
  const y = Number.isFinite(rawY) ? rawY : 0;
  const rawScore = Number(node.personalScore);
  const personalScore = Number.isFinite(rawScore) ? rawScore : 50;
  const rawStatusWeight = Number(node.statusWeight);
  const statusWeight = Number.isFinite(rawStatusWeight) ? Math.max(0, rawStatusWeight) : 0;
  const computedRadius =
    (node.kind === 'profile' || node.kind === 'source' ? 10 : 6 + personalScore / 35) +
    statusWeight * 1.5;
  const radius = Number.isFinite(computedRadius) && computedRadius > 0 ? computedRadius : 6;

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
  ctx.fillStyle = getRelationshipNodeColor(node);
  ctx.globalAlpha = node.id === selectedNodeId ? 1 : 0.88;
  ctx.fill();
  ctx.globalAlpha = 1;

  // İzleme geçmişi ve ilgi durumunu kişisel uyum puanından bağımsız dış halka olarak çiz
  if (node.statusSignal === 'completed-history' || node.statusSignal === 'interest') {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius + 2.2, 0, 2 * Math.PI, false);
    ctx.lineWidth = 1.25;
    if (node.statusSignal === 'interest') {
      ctx.setLineDash([2.5, 2]);
      ctx.strokeStyle = '#d3b579';
    } else {
      ctx.strokeStyle = '#63b8ab';
    }
    ctx.stroke();
    ctx.restore();
  }

  if (node.id === selectedNodeId) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius + 4, 0, 2 * Math.PI, false);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#f8fafc';
    ctx.stroke();
    ctx.restore();
  }

  if (globalScale > 0.7 || node.id === selectedNodeId) {
    const fontSize = Math.max(4, Math.min(12, 10 / globalScale));
    ctx.font = `${node.id === selectedNodeId ? '600 ' : ''}${fontSize}px Inter, Arial, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#dbeafe';
    ctx.fillText(node.label, x + radius + 4, y);
  }
}
