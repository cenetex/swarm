# Transfer Impact Assessment (TIA)

> Last updated: 2026-03-08
> Owner: Cenetex Inc. (Data Controller)
> Contact: privacy@cenetex.com
> Status: Initial assessment -- requires legal review
> Review cadence: Annual (next review due: 2027-03-08)

This document assesses the international transfer safeguards for personal data processed by the RATi Avatar System (RATi OS). It addresses GDPR Chapter V requirements for transfers of personal data to third countries.

## 1. Overview of Data Flows

Cenetex Inc. is incorporated in Canada. The RATi OS platform infrastructure is hosted on AWS in US regions (us-east-1, us-west-2). Most third-party processors are US-based. Where EU/EEA/UK data subjects use the platform, personal data transfers from the EU/EEA/UK to the US and other third countries occur.

## 2. Transfer Mechanisms by Processor

| # | Processor | Transfer Path | Legal Basis for Transfer | Mechanism | Status |
|---|-----------|---------------|-------------------------|-----------|--------|
| 1 | **AWS** | EU/EEA/UK -> US (us-east-1, us-west-2) | Art. 46(2)(c) SCCs + supplementary measures | AWS DPA includes SCCs; AWS participates in EU-US Data Privacy Framework (DPF) | Active -- covered by AWS service terms |
| 2 | **OpenRouter** | EU/EEA/UK -> US | To be determined | DPA with SCCs not yet executed | Pending -- TIA incomplete |
| 3 | **Replicate** | EU/EEA/UK -> US | To be determined | DPA with SCCs not yet executed | Pending -- TIA incomplete |
| 4 | **Privy** | EU/EEA/UK -> US | To be determined | DPA with SCCs not yet executed | Pending -- TIA incomplete |
| 5 | **Stripe** | EU/EEA/UK -> US / Global | Art. 46(2)(c) SCCs + DPF | Stripe DPA includes SCCs; Stripe is DPF-certified | Active -- covered by Stripe DPA |
| 6 | **Helius** | EU/EEA/UK -> US | Art. 49(1)(b) necessary for contract performance | Public blockchain data only; no personal data beyond pseudonymous wallet keys | Low risk -- assessment not required for public data |
| 7 | **Telegram** | EU/EEA/UK -> UAE / Global | N/A (independent controller) | User-initiated; Telegram's own privacy policy applies | Not a controlled transfer |
| 8 | **Discord** | EU/EEA/UK -> US | N/A (independent controller) | User-initiated; Discord's own privacy policy applies | Not a controlled transfer |
| 9 | **X / Twitter** | EU/EEA/UK -> US | N/A (independent controller) | User-initiated; X's own privacy policy applies | Not a controlled transfer |

## 3. Assessment of US Legal Framework

### 3.1 EU-US Data Privacy Framework (DPF)

Following the EU adequacy decision for the EU-US DPF (July 2023), transfers to DPF-certified US organizations benefit from an adequacy finding. The following processors in our stack have DPF certification or participate in the framework:

- **AWS**: DPF-certified (aws.amazon.com/compliance/eu-us-privacy-shield)
- **Stripe**: DPF-certified (stripe.com/legal/privacy-shield)
- **OpenRouter**: DPF certification status unknown -- to be confirmed
- **Replicate**: DPF certification status unknown -- to be confirmed
- **Privy**: DPF certification status unknown -- to be confirmed

### 3.2 Supplementary Measures

For processors where DPF certification is not confirmed, the following supplementary measures are in place or planned:

| Measure | Description | Status |
|---------|-------------|--------|
| Encryption in transit | All API calls to processors use TLS 1.2+ | Active |
| Encryption at rest | Data at rest encrypted via AWS KMS (AES-256) | Active |
| Data minimization | Only necessary data sent to each processor (e.g., conversation context to OpenRouter, not full user profiles) | Active |
| Pseudonymization | User identifiers in LLM prompts are avatar IDs, not user PII | Active |
| Contractual protections (SCCs) | Standard Contractual Clauses in processor agreements | Pending for OpenRouter, Replicate, Privy |
| Access controls | Processor access limited to API-level integration; no direct database access | Active |
| PII redaction in logs | Central redaction utility strips PII from all application logs | Active |

### 3.3 Risk Assessment for Pending Transfers

| Processor | Data Sensitivity | Volume | Risk Level | Mitigation Priority |
|-----------|-----------------|--------|------------|---------------------|
| **OpenRouter** | High (conversation content, system prompts) | High (every chat interaction) | **High** | Priority 1 -- DPA/SCC execution required |
| **Replicate** | Medium (AI prompts, input media) | Medium (media generation requests) | **Medium** | Priority 2 -- DPA/SCC execution required |
| **Privy** | High (email addresses, auth tokens) | Medium (authentication events) | **High** | Priority 1 -- DPA/SCC execution required |

## 4. Canada-Specific Considerations

Cenetex Inc. is incorporated in Canada. The EU has recognized Canada (PIPEDA) as providing adequate protection for personal data (Commission Decision 2002/2/EC), subject to the scope limitations of that adequacy decision. Transfers from the EU to Canada for processing activities within PIPEDA's scope benefit from this adequacy finding.

For transfers from Canada to the US, PIPEDA's accountability principle requires comparable protection. The supplementary measures in Section 3.2 apply.

## 5. Action Items

| # | Action | Owner | Target Date | Status |
|---|--------|-------|-------------|--------|
| 1 | Execute DPA with SCCs with OpenRouter | Legal team | 2026-04-30 | Not started |
| 2 | Execute DPA with SCCs with Replicate | Legal team | 2026-04-30 | Not started |
| 3 | Execute DPA with SCCs with Privy | Legal team | 2026-04-30 | Not started |
| 4 | Confirm DPF certification status for OpenRouter, Replicate, Privy | Legal team | 2026-04-15 | Not started |
| 5 | Evaluate EU-region AWS deployment option to reduce transfer scope | Engineering | 2026-06-30 | Not started |
| 6 | Legal review of this TIA document | Legal counsel | 2026-04-30 | Not started |
| 7 | Annual TIA refresh | Privacy team | 2027-03-08 | Scheduled |

## 6. Conclusion

**Current state:** International transfers to the US are partially safeguarded. AWS and Stripe transfers are covered by executed DPAs with SCCs and DPF certification. Transfers to OpenRouter, Replicate, and Privy lack executed DPAs and SCCs -- these are the highest-priority gaps.

**Technical supplementary measures** (encryption, minimization, pseudonymization, PII redaction) provide a baseline of protection for all transfers, but do not replace the need for contractual safeguards.

**Recommendation:** Execute DPAs with SCCs with OpenRouter, Replicate, and Privy before the next quarterly review (2026-06-08). Confirm DPF certification status for each. Consider EU-region infrastructure deployment to reduce transfer scope for EU data subjects.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-03-08 | Initial TIA created | Engineering |
