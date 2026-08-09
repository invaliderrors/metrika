import { Injectable } from './injectable.js';
import { WidgetService } from './service.js';

@Injectable()
export class ValueImportController {
  constructor(private readonly widgets: WidgetService) {}

  read(): string {
    return this.widgets.getWidget();
  }
}
