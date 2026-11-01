import type { RelationshipGraphNode } from '../core/relationship-explorer.ts';
import { getRelationshipNodeColor } from '../core/relationship-wordlists.ts';

export function renderRelationshipCanvasNode(
  rawNode: any,
  ctx: CanvasRenderingContext2D,
  globalScale: number,
  selectedNodeId?: string,
): void {
  if (!rawNode || !ctx) return;
  const node = rawNode as RelationshipGraphNode & { x?: number; y?: number };
  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  const personalScore = Number(node.personalScore) || 50;
  const radius =
    (node.kind === 'profile' || node.kind === 'source' ? 10 : 6 + personalScore / 35) +
    Math.max(0, Number(node.statusWeight) || 0) * 1.5;

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
      ctx.strokeStyle = '#fbbf24';
    } else {
      ctx.strokeStyle = '#7dd3fc';
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
