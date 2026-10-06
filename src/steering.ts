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
