import { Injectable } from './injectable.js';
import type { WidgetService } from './service.js';

@Injectable()
export class TypeImportController {
  constructor(private readonly widgets: WidgetService) {}

  read(): string {
    return this.widgets.getWidget();
  }
}
