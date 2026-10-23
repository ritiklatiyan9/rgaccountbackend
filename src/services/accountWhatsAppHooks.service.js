import {
  accountPaymentEvent, isAccountWhatsAppBookingTransition, isAccountWhatsAppClient,
} from './accountWhatsAppWorkflow.policy.js';

// Resolve the provider/outbox lazily: importing a business controller must not
// initialise a sender. Hooks only enqueue committed references, never send.
const enqueueCommittedReference = async (...args) => {
  // Existing controller tests do not opt in to messaging infrastructure.
  // Hook tests inject a local outbox so they still exercise all dispatch rules.
  if (process.env.NODE_TEST_CONTEXT) return { queued: false, reason: 'test_context' };
  const { queueAccountWhatsApp } = await import('./accountWhatsApp.service.js');
  return queueAccountWhatsApp(...args);
};

export function createAccountWhatsAppHooks(enqueue = enqueueCommittedReference) {
  const queue = async (event, refId, siteId) => {
    if (!Number.isSafeInteger(Number(refId)) || Number(refId) <= 0) return { queued: false, reason: 'missing_reference' };
    try {
      return await enqueue(event, Number(refId), { siteId, dedupeKey: `${event}:${refId}` });
    } catch (error) {
      // A messaging outage cannot turn a committed financial write into an
      // apparent failure that encourages the operator to record it twice.
      console.error('[account-whatsapp] Could not queue workflow event:', event, error?.message || error);
      return { queued: false, reason: 'queue_failed' };
    }
  };

  return {
    clientOnboarded: (member) => isAccountWhatsAppClient(member)
      ? queue('CLIENT_ONBOARDED', member.id, member.site_id) : Promise.resolve({ queued: false, reason: 'not_client' }),
    kycVerified: (kycCase) => queue('KYC_VERIFIED', kycCase.id, kycCase.site_id),
    plotBooked: (plot, previous = null) => isAccountWhatsAppBookingTransition(plot, previous)
      ? queue('PLOT_BOOKED', plot.id, plot.site_id) : Promise.resolve({ queued: false, reason: 'not_booked_transition' }),
    paymentApproved: (source, payment) => {
      const event = accountPaymentEvent(source, payment);
      return event ? queue(event, payment.id, payment.site_id) : Promise.resolve({ queued: false, reason: 'ineligible_payment' });
    },
    chequeCommitted: async (source, change) => {
      // A deferred company-plot booking becomes real on clearance. Its plot
      // review still has to be approved before the booking event can send.
      if (String(change?.after?.cheque_status || '').trim().toUpperCase() !== 'CLEARED') {
        return { queued: false, reason: 'not_cleared' };
      }
      const event = accountPaymentEvent(source, change.after);
      return event
        ? queue(event, change.after.id, change.after.site_id)
        : { queued: false, reason: 'awaiting_payment_approval' };
    },
    registryCompleted: (registry) => registry?.registry_date
      ? queue('REGISTRY_COMPLETED', registry.id, registry.site_id) : Promise.resolve({ queued: false, reason: 'missing_registry_date' }),
  };
}

export const accountWhatsAppHooks = createAccountWhatsAppHooks();
