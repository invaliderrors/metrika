import { Global, Module } from '@nestjs/common';
import { loadEnv } from './env.js';
import { EnvService } from './env.service.js';

@Global()
@Module({
  providers: [
    {
      provide: EnvService,
      useFactory: (): EnvService => new EnvService(loadEnv()),
    },
  ],
  exports: [EnvService],
})
export class ConfigModule {}
