export function Module(_metadata: Record<string, unknown>): ClassDecorator {
  return () => undefined;
}

@Module({ imports: [], providers: [] })
export class AppModule {}
