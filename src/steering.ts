export interface SteeringRolePrompt {
  system?: string
  append?: string
}

export interface SteeringBundle {
  id: string
  coderPrompt?: string
  continuePrompt?: string
  reviewerPrompts?: Record<string, string>
  skills?: string[]
  rolePrompts?: Record<string, SteeringRolePrompt>
  metadata?: Record<string, unknown>
}

export interface SteeringDelta {
  coderPrompt?: string
  continuePrompt?: string
  reviewerPrompts?: Record<string, string>
  skills?: string[]
  rolePrompts?: Record<string, SteeringRolePrompt>
  metadata?: Record<string, unknown>
}

export function mergeSteeringBundle(base: SteeringBundle, delta: SteeringDelta): SteeringBundle {
  return {
    ...base,
    ...(delta.coderPrompt !== undefined ? { coderPrompt: delta.coderPrompt } : {}),
    ...(delta.continuePrompt !== undefined ? { continuePrompt: delta.continuePrompt } : {}),
    reviewerPrompts: {
      ...(base.reviewerPrompts ?? {}),
      ...(delta.reviewerPrompts ?? {}),
    },
    skills: delta.skills ?? base.skills,
    rolePrompts: {
      ...(base.rolePrompts ?? {}),
      ...(delta.rolePrompts ?? {}),
    },
    metadata: {
      ...(base.metadata ?? {}),
      ...(delta.metadata ?? {}),
    },
  }
}

export function renderSteeringText(bundle: SteeringBundle): string {
  const lines: string[] = [`bundle:${bundle.id}`]
  if (bundle.coderPrompt) lines.push(`coder:${bundle.coderPrompt}`)
  if (bundle.continuePrompt) lines.push(`continue:${bundle.continuePrompt}`)
  const reviewers = Object.entries(bundle.reviewerPrompts ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  for (const [name, prompt] of reviewers) lines.push(`reviewer:${name}:${prompt}`)
  const skills = [...(bundle.skills ?? [])].sort()
  if (skills.length) lines.push(`skills:${skills.join(',')}`)
  return lines.join('\n')
}
