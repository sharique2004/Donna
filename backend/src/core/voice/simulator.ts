import type {
  DonationItem, OfferDraft, Recipient, CallAttempt, CallOutcome, HistoryEvent,
} from '../types.js';
import type { VoiceProvider } from './caller.js';
import { humanize } from '../text/humanize.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** 'fresh_produce' → 'fresh produce' — used in reasons and 7-day memory matching. */
function humanizeCategory(category: string): string {
  return humanize(category);
}

/**
 * Did this recipient decline this category within the last 7 days?
 * HistoryEvent carries no category column, so we match on the decline reason —
 * every category-driven decline reason embeds the humanized category name.
 */
function declinedCategoryRecently(
  history: HistoryEvent[],
  recipientId: string,
  category: string,
  nowMs: number,
): boolean {
  const human = humanizeCategory(category);
  const cutoff = nowMs - SEVEN_DAYS_MS;
  return history.some((e) => {
    if (e.recipientId !== recipientId) return false;
    if (e.outcome !== 'declined') return false;
    const at = Date.parse(e.at);
    if (Number.isFinite(at) && at < cutoff) return false;
    return (e.reason ?? '').toLowerCase().includes(human.toLowerCase());
  });
}

function hasColdChain(recipient: Recipient): boolean {
  return recipient.infrastructure.some(
    (i) => i === 'walk_in_fridge' || i === 'fridge' || i === 'freezer',
  );
}

interface Decision {
  outcome: CallOutcome;
  reason?: string;
  personaLine: string;
}

/**
 * §7.2 — deterministic recipient persona. No randomness.
 * Rule order matters: rejects → over-capacity → cold chain → 7-day memory → accept.
 */
export class SimulatorVoice implements VoiceProvider {
  constructor(private history: HistoryEvent[] = []) {}

  setHistory(history: HistoryEvent[]): void {
    this.history = history;
  }

  private decide(recipient: Recipient, item: DonationItem, nowMs: number): Decision {
    const human = humanizeCategory(item.category);

    // 1. Hard category rejection.
    if (recipient.rejects.includes(item.category)) {
      return {
        outcome: 'declined',
        reason: `we don't take ${human}`,
        personaLine:
          `Sorry, we don't take ${human} here — it just moves through our ` +
          `${recipient.type === 'pantry' ? 'pantry' : 'agency'}.`,
      };
    }

    // 2. Over capacity for the week.
    const ratio = recipient.typicalWeeklyVolumeLbs > 0
      ? item.qtyLbs / recipient.typicalWeeklyVolumeLbs
      : Infinity;
    if (ratio > 1.5) {
      return {
        outcome: 'declined',
        reason: `that's more than we can move this week`,
        personaLine:
          `That's ${item.qtyLbs} lbs — more than we can move this week. ` +
          `We usually handle about ${recipient.typicalWeeklyVolumeLbs} lbs total.`,
      };
    }

    // 3. Needs refrigeration but no cold storage.
    if (item.needsRefrigeration && !hasColdChain(recipient)) {
      return {
        outcome: 'declined',
        reason: `no cold storage available`,
        personaLine:
          `We'd love to, but we've only got ${recipient.infrastructure.map(humanize).join(', ') || 'dry shelving'} ` +
          `— no cold storage for something that needs refrigeration.`,
      };
    }

    // 4. Already declined this category in the last 7 days.
    if (declinedCategoryRecently(this.history, recipient.id, item.category, nowMs)) {
      return {
        outcome: 'declined',
        reason: `we're still overstocked on ${human}`,
        personaLine:
          `Like I mentioned earlier this week, we're still overstocked on ${human} ` +
          `— can't take more right now.`,
      };
    }

    // 5. Accept.
    const coldNote = item.needsRefrigeration
      ? ` We've got ${recipient.infrastructure.find((i) => i === 'walk_in_fridge')
          ? 'the walk-in fridge'
          : 'cold storage'} ready for it.`
      : ` It'll go straight onto our ${recipient.infrastructure.includes('dry_storage') ? 'dry shelves' : 'shelves'}.`;
    return {
      outcome: 'accepted',
      personaLine:
        `Yes — we can absolutely use ${item.qtyLbs} lbs of ${item.item}.` + coldNote,
    };
  }

  /**
   * No real call is placed, so the id is synthetic — the machine still stores a
   * CallRecord under it and still resolves it through onCallReport, so the
   * simulated and live paths run identical code.
   */
  async startCall(): Promise<string> {
    return `sim_${crypto.randomUUID()}`;
  }

  /** The outcome, decided immediately: no webhook is ever coming. */
  async synthesizeReport(
    offer: OfferDraft,
    recipient: Recipient,
    item: DonationItem,
  ): Promise<Pick<CallAttempt, 'outcome' | 'reason' | 'transcript'>> {
    const attempt = await this.buildAttempt(offer, recipient, item);
    return { outcome: attempt.outcome, reason: attempt.reason, transcript: attempt.transcript };
  }

  private async buildAttempt(
    offer: OfferDraft,
    recipient: Recipient,
    item: DonationItem,
  ): Promise<CallAttempt> {
    const now = new Date();
    const decision = this.decide(recipient, item, now.getTime());

    const leadName = recipient.leadContact || 'the coordinator';
    const transcript: CallAttempt['transcript'] = [
      { speaker: 'agent', text: offer.script },
      {
        speaker: 'recipient',
        text: `Hi, this is ${leadName} at ${recipient.name}.`,
      },
      {
        speaker: 'agent',
        text:
          `We've got ${item.qtyLbs} lbs of ${item.item} that needs a home ` +
          `${item.needsRefrigeration ? 'and it needs refrigeration' : 'today'}. ` +
          `Can ${recipient.name} take it?`,
      },
      { speaker: 'recipient', text: decision.personaLine },
    ];

    if (decision.outcome === 'accepted') {
      transcript.push({
        speaker: 'agent',
        text:
          `Perfect — I'll send the pickup details` +
          `${recipient.bestCallWindow ? ` and we'll aim for your ${recipient.bestCallWindow} window` : ''}. ` +
          `Thanks, ${leadName}!`,
      });
      transcript.push({ speaker: 'recipient', text: `Great, talk soon.` });
    } else {
      transcript.push({
        speaker: 'agent',
        text: `Understood — thanks for letting me know, ${leadName}. I'll find another home for it.`,
      });
    }

    return {
      recipientId: recipient.id,
      recipientName: recipient.name,
      outcome: decision.outcome,
      reason: decision.reason,
      transcript,
      at: now.toISOString(),
      simulated: true,
    };
  }
}
