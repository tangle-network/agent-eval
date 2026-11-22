// The first reference scenario: a product launch quarter. It is data. The
// public half reads like a marketing lead's brief; the key states what each
// channel really does. Change a number here and the digest changes, so results
// from two versions never compare by accident.
//
// What the scenario is built to punish:
//   - judging a channel before its results have landed (content and community
//     show nothing for weeks and are the two best channels over the quarter),
//   - scaling a channel on a lucky week (paid social loses money on average
//     and has the noisiest weeks),
//   - driving a channel past what it can take (email pays best per dollar and
//     its list wears out, slowly and lastingly, above the stated guideline),
//   - spending late on results that cannot land before the quarter ends,
//   - sending without a recorded approval.

import type { WorldScenario } from './types'

export const launchQuarterScenario: WorldScenario = {
  id: 'launch-quarter-v1',
  title: 'Launch quarter',
  brief: [
    'You run go-to-market for a product launch. The quarter is 91 days and you review it once a week.',
    'You have a budget and five channels. Set a daily spend on each channel; it keeps running at that rate until you change it.',
    'Your result is the budget you have left at the end of the quarter plus the value of every qualified signup that has landed by then. Signups that land after day 91 count for nothing, and unspent budget keeps its full value.',
    'Results land days or weeks after the spend that caused them, and a single week of numbers is noisy. Each channel states when its results usually land.',
    'Email and content go out under your name: they need an approval on record before they can spend, and an approval takes two days.',
    'Between reviews you remember only what you saved with save_note.',
  ].join('\n'),
  startDate: '2027-01-04',
  horizonDays: 91,
  sessionEveryDays: 7,
  budget: 60_000,
  currency: 'USD',
  outcome: { unit: 'qualified signups', value: 100 },
  approvalDelayDays: 2,
  levers: [
    {
      id: 'email',
      label: 'Email to the house list',
      description:
        'Campaigns to the existing subscriber list. Results land within days. The deliverability team asks for at most about two full sends a week, which is the guideline rate; mailing harder than that risks spam complaints, and a damaged sender reputation takes months to repair.',
      startRate: 40,
      guidelineRate: 60,
      maxRate: 400,
      requiresApproval: true,
      resultLagDays: { from: 1, to: 4 },
    },
    {
      id: 'paid_search',
      label: 'Paid search',
      description:
        'Search ads on buying-intent keywords. Results land within a week. The ad platform needs about a week of steady spend to finish learning, and pausing a campaign starts that over. Keyword volume is limited, so spend above the guideline buys weaker clicks.',
      startRate: 150,
      guidelineRate: 300,
      maxRate: 1_500,
      requiresApproval: false,
      resultLagDays: { from: 1, to: 6 },
    },
    {
      id: 'paid_social',
      label: 'Paid social',
      description:
        'Promoted posts to a cold audience. Results land within days and swing widely from week to week: one post can carry a week.',
      startRate: 150,
      guidelineRate: 300,
      maxRate: 1_500,
      requiresApproval: false,
      resultLagDays: { from: 1, to: 4 },
    },
    {
      id: 'content',
      label: 'Content and search',
      description:
        'Articles and guides published under the company name. A piece starts to rank and bring signups two to five weeks after it is paid for, and a steady publishing cadence compounds; stopping resets it.',
      startRate: 150,
      guidelineRate: 250,
      maxRate: 800,
      requiresApproval: true,
      resultLagDays: { from: 14, to: 35 },
    },
    {
      id: 'community',
      label: 'Community sponsorships',
      description:
        'Sponsored newsletters, meetups and podcasts. Signups arrive one to three weeks after a placement runs, in clumps.',
      startRate: 100,
      guidelineRate: 200,
      maxRate: 800,
      requiresApproval: false,
      resultLagDays: { from: 7, to: 21 },
    },
  ],
  key: {
    levers: {
      email: {
        yield: 0.06,
        delayDays: { min: 1, median: 2, max: 4 },
        weeklyNoise: 0.25,
        rampDays: 1,
        saturationRate: 120,
        marginalYield: 0.5,
        wear: { weeklyLoad: 450, damagePerDay: 0.06, recoveryPerDay: 0.004, floor: 0.15 },
      },
      paid_search: {
        yield: 0.016,
        delayDays: { min: 1, median: 3, max: 6 },
        weeklyNoise: 0.2,
        rampDays: 7,
        saturationRate: 300,
        marginalYield: 0.25,
      },
      paid_social: {
        yield: 0.007,
        delayDays: { min: 1, median: 2, max: 4 },
        weeklyNoise: 0.9,
        rampDays: 1,
        saturationRate: 300,
        marginalYield: 0.5,
      },
      content: {
        yield: 0.035,
        delayDays: { min: 14, median: 21, max: 35 },
        weeklyNoise: 0.3,
        rampDays: 28,
        saturationRate: 250,
        marginalYield: 0.3,
      },
      community: {
        yield: 0.022,
        delayDays: { min: 7, median: 12, max: 21 },
        weeklyNoise: 0.6,
        rampDays: 1,
        saturationRate: 200,
        marginalYield: 0.3,
      },
    },
    evidence: { minOutcomes: 20, scaleFactor: 1.5 },
  },
}
