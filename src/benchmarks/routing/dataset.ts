/**
 * Synthetic routing dataset. 16 tasks across 4 categories. Used as a
 * deterministic, dependency-free benchmark for any router that maps a
 * natural-language request to one of a fixed set of route labels.
 *
 * Format (see `routing/README.md` for prose):
 *
 *   {
 *     id:           stable per-task ID (matches across processes).
 *     category:     one of the four route labels.
 *     prompt:       the user-facing request the router must classify.
 *     route:        the ground-truth route the router should pick.
 *     synonyms:     other strings that count as a correct answer.
 *     hardNegatives:close-but-wrong route labels — used to detect the
 *                   "always picks the popular route" failure mode.
 *   }
 *
 * The four categories are intentionally cross-domain (file ops,
 * math, search, conversation) so a router that collapses to one
 * category is easy to spot.
 */

export interface RoutingItem {
  id: string
  category: 'file' | 'math' | 'search' | 'chat'
  prompt: string
  /** Canonical correct route label. */
  route: string
  /** Alternate route labels that also count as correct. */
  synonyms: string[]
  /** Wrong-but-tempting route labels (for analysis, not grading). */
  hardNegatives: string[]
}

export const ROUTING_DATASET: RoutingItem[] = [
  {
    id: 'file_001',
    category: 'file',
    prompt: 'Save the meeting notes to /tmp/notes-2025-04.md as markdown.',
    route: 'fs.write',
    synonyms: ['filesystem.write', 'write_file'],
    hardNegatives: ['fs.read', 'chat.reply'],
  },
  {
    id: 'file_002',
    category: 'file',
    prompt: 'Read the contents of /etc/hosts and summarize the entries.',
    route: 'fs.read',
    synonyms: ['filesystem.read', 'read_file'],
    hardNegatives: ['fs.write', 'search.web'],
  },
  {
    id: 'file_003',
    category: 'file',
    prompt: 'List every Python file under src/ recursively.',
    route: 'fs.list',
    synonyms: ['filesystem.list', 'list_files'],
    hardNegatives: ['fs.read', 'search.code'],
  },
  {
    id: 'file_004',
    category: 'file',
    prompt: 'Delete the cached build at .turbo/cache.',
    route: 'fs.delete',
    synonyms: ['filesystem.delete', 'remove_file'],
    hardNegatives: ['fs.write', 'fs.list'],
  },
  {
    id: 'math_001',
    category: 'math',
    prompt: 'What is the integral of 3x^2 + 2x from 0 to 5?',
    route: 'math.integral',
    synonyms: ['calculator.integral', 'math.solve'],
    hardNegatives: ['math.derivative', 'chat.reply'],
  },
  {
    id: 'math_002',
    category: 'math',
    prompt: 'Compute the derivative of sin(x) * cos(x).',
    route: 'math.derivative',
    synonyms: ['calculator.derivative', 'math.solve'],
    hardNegatives: ['math.integral', 'math.algebra'],
  },
  {
    id: 'math_003',
    category: 'math',
    prompt: 'Solve 2x + 7 = 19 for x.',
    route: 'math.algebra',
    synonyms: ['calculator.algebra', 'math.solve'],
    hardNegatives: ['math.derivative', 'math.integral'],
  },
  {
    id: 'math_004',
    category: 'math',
    prompt: 'What is the prime factorization of 360?',
    route: 'math.numbertheory',
    synonyms: ['calculator.factor', 'math.solve'],
    hardNegatives: ['math.algebra', 'search.web'],
  },
  {
    id: 'search_001',
    category: 'search',
    prompt: 'Find recent papers on agent prompt optimization with held-out promotion gates.',
    route: 'search.web',
    synonyms: ['web.search', 'search.papers'],
    hardNegatives: ['search.code', 'chat.reply'],
  },
  {
    id: 'search_002',
    category: 'search',
    prompt: 'Search the codebase for every call site of `runProposeReview`.',
    route: 'search.code',
    synonyms: ['code.search', 'grep'],
    hardNegatives: ['search.web', 'fs.read'],
  },
  {
    id: 'search_003',
    category: 'search',
    prompt: 'What is the latest release of the Tangle network on GitHub?',
    route: 'search.web',
    synonyms: ['web.search', 'github.releases'],
    hardNegatives: ['search.code', 'chat.reply'],
  },
  {
    id: 'search_004',
    category: 'search',
    prompt: 'Find all TODO comments in the agent-eval src tree.',
    route: 'search.code',
    synonyms: ['code.search', 'grep'],
    hardNegatives: ['search.web', 'fs.list'],
  },
  {
    id: 'chat_001',
    category: 'chat',
    prompt: 'Hi there, how are you doing today?',
    route: 'chat.reply',
    synonyms: ['conversation.reply'],
    hardNegatives: ['search.web', 'fs.read'],
  },
  {
    id: 'chat_002',
    category: 'chat',
    prompt: 'Please explain the difference between an LLM and a foundation model.',
    route: 'chat.reply',
    synonyms: ['conversation.reply', 'qa.answer'],
    hardNegatives: ['search.web', 'math.algebra'],
  },
  {
    id: 'chat_003',
    category: 'chat',
    prompt: 'Tell me a short joke about distributed systems.',
    route: 'chat.reply',
    synonyms: ['conversation.reply'],
    hardNegatives: ['search.web', 'fs.read'],
  },
  {
    id: 'chat_004',
    category: 'chat',
    prompt: 'Acknowledge my last message with a thumbs up.',
    route: 'chat.reply',
    synonyms: ['conversation.reply', 'react'],
    hardNegatives: ['fs.write', 'search.web'],
  },
]
