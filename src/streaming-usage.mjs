// Streaming-start usage in transcripts (see docs/backfill-output-undercount.md).
// A subagent's assistant record can carry the usage from the start of the stream (output_tokens 3 for a 20K-char Write) and
// stop_reason null: the final usage was never written back. Records of a finished message all carry the final usage and a stop_reason.
// Detection reads only stop_reason. The estimate reads block sizes in memory and keeps nothing.

// Least-squares fit of reported OTel output_tokens on transcript content, over 6,228 subagent messages whose usage was streaming-start
// and whose request_id OTel also reported (2026-10-15..21). Thinking text is blank in these transcripts, so each thinking block is charged
// a flat amount. The fit is for those models (mostly claude-sonnet-5-5 and claude-opus-5-5); elsewhere it is an extrapolation.
export const FIT = { base: 52, perChar: 0.453, perThinkingBlock: 450 };

// stop_reason null on the last record of a message means the message was never finalized in the transcript.
export const isStreamingStart = (stopReason) => stopReason == null;

// Size of one message's content: visible characters (text, thinking text, JSON of tool_use input) and blank thinking blocks.
export function addShape(shape, content) {
  for (const b of Array.isArray(content) ? content : []) {
    if (!b) continue;
    if (b.type === 'text') shape.chars += (b.text || '').length;
    else if (b.type === 'thinking') { const n = (b.thinking || '').length; shape.chars += n; if (!n) shape.blankThinking++; }
    else if (b.type === 'tool_use') shape.chars += JSON.stringify(b.input ?? {}).length;
  }
  return shape;
}
export const newShape = () => ({ chars: 0, blankThinking: 0 });

export const estimateOutput = (s, fit = FIT) => Math.round(fit.base + fit.perChar * s.chars + fit.perThinkingBlock * s.blankThinking);
