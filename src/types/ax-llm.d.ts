declare module '@ax-llm/ax' {
  export function ai(config: any): any
  export function ax(signature: string, options?: any): any
  export class AxGEPA {
    constructor(options?: any)
    compile(program: any, train: any, metricFn: any, options?: any): Promise<any>
  }
}
