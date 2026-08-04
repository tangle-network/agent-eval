export function createModelExecutionOwner({ model }) {
  return {
    callRef: `test-owner:${model}`,
    call: async () => {
      throw new Error('the injected benchmark runner must prevent model execution')
    },
    recordExecution: () => {},
  }
}
