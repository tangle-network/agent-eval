/**
 * Canonical Phase-B scenarios — 15 marketing rewrite tasks across the
 * surfaces a real GTM agent encounters in production. Diverse enough
 * that improvement to the SYSTEM PROMPT generalizes (not over-fit to
 * one surface) and that the gate's held-out split (4 of 15) measures
 * real out-of-distribution lift.
 */

import type { Scenario } from '../../src/contract'

export type Surface =
  | 'landing-hero'
  | 'landing-h1'
  | 'tweet'
  | 'email-subject'
  | 'cold-outreach-subject'
  | 'product-hunt-tagline'
  | 'linkedin-post'
  | 'push-notification'
  | 'app-store-short'
  | 'banner-ad'
  | 'newsletter-subject'
  | 'onboarding-empty-state'
  | 'pricing-hero'
  | 'demo-cta-button'
  | 'sales-followup-subject'

export interface MarketingScenario extends Scenario {
  blurb: string
  surface: Surface
  audience: string
  voiceConstraints: string[]
  proofPoints: string[]
}

export const MARKETING_SCENARIOS: MarketingScenario[] = [
  {
    id: 'm01-b2b-saas-hero',
    kind: 'marketing-rewrite',
    surface: 'landing-hero',
    audience: 'engineering leaders at series-A through C startups',
    blurb: 'We help engineering teams ship code faster by automatically writing tests from production traces.',
    voiceConstraints: ['no "revolutionary" / "powerful" / "seamless"', 'specific to engineering audiences', 'evidence > adjectives'],
    proofPoints: ['90% test coverage in 1 week (claimed)', 'works with existing CI'],
    tags: ['b2b', 'dev-tools', 'hero'],
  },
  {
    id: 'm02-consumer-notes-tweet',
    kind: 'marketing-rewrite',
    surface: 'tweet',
    audience: 'consumer prosumers — knowledge workers, students, indie creators',
    blurb: 'Our note-taking app uses AI to surface connections between your notes you would have missed.',
    voiceConstraints: ['fits in 240 chars', 'no jargon', 'curious, not salesy'],
    proofPoints: ['AI surfaces note connections', 'cross-references over time'],
    tags: ['consumer', 'productivity', 'social'],
  },
  {
    id: 'm03-fintech-email-subject',
    kind: 'marketing-rewrite',
    surface: 'email-subject',
    audience: 'self-employed contractors filing 1099s',
    blurb: 'Track expenses, file taxes, get every refund you are owed — guided by an AI tax pro.',
    voiceConstraints: ['under 60 chars for mobile', 'concrete benefit', 'trust without being boring'],
    proofPoints: ['guided filing', 'finds deductions', 'AI tax pro context'],
    tags: ['fintech', 'tax', 'email'],
  },
  {
    id: 'm04-sales-tool-cold-outreach',
    kind: 'marketing-rewrite',
    surface: 'cold-outreach-subject',
    audience: 'VPs of sales at $50M-$500M B2B SaaS companies',
    blurb: 'Our platform helps sales teams send better cold email by drafting from the prospect\'s own public posts.',
    voiceConstraints: ['no spam triggers (FREE, !!!, ALL CAPS)', 'sounds like a person, not marketing', 'curious, not transactional'],
    proofPoints: ['personalized from public signal', 'higher reply rate (specific number TBD)'],
    tags: ['b2b', 'sales', 'email'],
  },
  {
    id: 'm05-healthtech-h1',
    kind: 'marketing-rewrite',
    surface: 'landing-h1',
    audience: 'people newly diagnosed with type-2 diabetes who want to manage without medication',
    blurb: 'Our app helps you reverse type-2 diabetes through continuous glucose monitoring and personalized meal plans.',
    voiceConstraints: ['no medical claims we cannot back', 'empathetic — they are scared', 'agency > pity'],
    proofPoints: ['CGM data integration', 'personalized meal plans', 'reversal claim needs hedging'],
    tags: ['healthtech', 'consumer', 'h1', 'sensitive'],
  },
  {
    id: 'm06-marketing-tool-ph-tagline',
    kind: 'marketing-rewrite',
    surface: 'product-hunt-tagline',
    audience: 'Product Hunt browsers (indie makers, early adopters)',
    blurb: 'Generate marketing copy with AI — drafts that sound on-brand because we train on your past content.',
    voiceConstraints: ['witty without being smug', 'fits PH 60-char tagline limit', 'self-aware about AI marketing tools'],
    proofPoints: ['trains on past content', 'on-brand outputs'],
    tags: ['meta', 'launch', 'tagline'],
  },
  {
    id: 'm07-b2b-platform-linkedin',
    kind: 'marketing-rewrite',
    surface: 'linkedin-post',
    audience: 'enterprise IT directors at Fortune 1000s',
    blurb: 'Our platform consolidates 12 separate compliance tools (SOC2, ISO27001, HIPAA, FedRAMP) into one evidence-collection workflow.',
    voiceConstraints: ['LinkedIn-appropriate (formal but not stiff)', 'concrete numbers > vague claims', 'no "we are excited to announce"'],
    proofPoints: ['12 frameworks consolidated', 'one evidence workflow'],
    tags: ['b2b', 'enterprise', 'social'],
  },
  {
    id: 'm08-fitness-push',
    kind: 'marketing-rewrite',
    surface: 'push-notification',
    audience: 'lapsed users of a running app (last opened 14+ days ago)',
    blurb: 'Come back — your running streak is waiting. Last week was 27% slower than your best month; we have a coach plan to get you back.',
    voiceConstraints: ['fits 100 chars iOS truncation', 'tap-through worthy', 'no guilt-trip — agency'],
    proofPoints: ['streak data', '27% slower fact', 'coach plan offer'],
    tags: ['consumer', 'fitness', 'retention'],
  },
  {
    id: 'm09-productivity-app-store',
    kind: 'marketing-rewrite',
    surface: 'app-store-short',
    audience: 'iOS App Store browsers searching "task manager"',
    blurb: 'A task manager that automatically schedules your to-dos around your calendar so you never overload your day.',
    voiceConstraints: ['App Store 30-char limit on subtitle', 'one concrete differentiator from generic task apps', 'concrete > clever'],
    proofPoints: ['calendar-aware scheduling', 'overload prevention'],
    tags: ['consumer', 'productivity', 'app-store'],
  },
  {
    id: 'm10-fashion-banner',
    kind: 'marketing-rewrite',
    surface: 'banner-ad',
    audience: 'women 28-45 who shop sustainable fashion online',
    blurb: 'Sustainable fashion that does not look like sustainable fashion — natural fabrics, traditional cuts, transparent supply chain.',
    voiceConstraints: ['banner = 1 line + CTA', 'no greenwashing platitudes', 'aspirational, not preachy'],
    proofPoints: ['natural fabrics', 'transparent supply chain', '"does not look like sustainable fashion"'],
    tags: ['consumer', 'fashion', 'banner'],
  },
  {
    id: 'm11-dev-newsletter-subject',
    kind: 'marketing-rewrite',
    surface: 'newsletter-subject',
    audience: 'subscribers of a weekly senior-engineer newsletter (architecture, post-mortems, scaling)',
    blurb: 'This week: how Cloudflare survived an internal DNS-rotation incident, plus a deep dive on log-structured merge trees.',
    voiceConstraints: ['under 60 chars', 'specific > clickbait', 'no "you will not believe what happened next"'],
    proofPoints: ['Cloudflare DNS incident', 'LSM tree deep dive'],
    tags: ['b2b', 'dev', 'newsletter'],
  },
  {
    id: 'm12-video-app-onboarding',
    kind: 'marketing-rewrite',
    surface: 'onboarding-empty-state',
    audience: 'video creators on their first session in a new editing app',
    blurb: 'Drop a video to start editing — we will auto-detect scenes, generate captions, and suggest cuts. You can override everything.',
    voiceConstraints: ['empty-state copy that invites, not lectures', 'positions AI as assist not authority', 'one or two short sentences max'],
    proofPoints: ['scene detection', 'captions', 'cut suggestions', 'user override'],
    tags: ['consumer', 'video', 'onboarding'],
  },
  {
    id: 'm13-ai-infra-pricing',
    kind: 'marketing-rewrite',
    surface: 'pricing-hero',
    audience: 'ML platform engineers evaluating an AI inference router',
    blurb: 'Pay per token across 30+ models, with one API. Free tier covers your prototyping; production scales linearly with usage.',
    voiceConstraints: ['no "simple pricing" — show, do not tell', 'concrete: 30+ models, free tier, per-token', 'engineer-credible'],
    proofPoints: ['30+ models', 'free prototyping tier', 'linear-scaling production', 'one API'],
    tags: ['b2b', 'ai-infra', 'pricing'],
  },
  {
    id: 'm14-enterprise-demo-cta',
    kind: 'marketing-rewrite',
    surface: 'demo-cta-button',
    audience: 'enterprise buyers on a B2B SaaS pricing page',
    blurb: 'Book a personalized demo with a solutions engineer. We will tailor to your stack and use cases.',
    voiceConstraints: ['button copy: 2-4 words', 'specific > "Learn More"', 'commitment level appropriate to enterprise (medium)'],
    proofPoints: ['personalized', 'solutions engineer', 'tailored to stack'],
    tags: ['b2b', 'enterprise', 'cta'],
  },
  {
    id: 'm15-saas-followup-subject',
    kind: 'marketing-rewrite',
    surface: 'sales-followup-subject',
    audience: 'a prospect who had a discovery call 5 days ago and went quiet',
    blurb: 'Following up on our Tuesday call — we discussed the data-residency requirement and I wanted to share how 3 customers solved this with us.',
    voiceConstraints: ['no "circling back" / "just checking in"', 'reference the specific topic of the prior call', 'value, not nag'],
    proofPoints: ['Tuesday discovery call context', 'data-residency topic', '3 customer references'],
    tags: ['b2b', 'sales', 'email', 'followup'],
  },
]
