import { Component, OnInit } from '@angular/core';
import { HttpResponse } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { MatSnackBar } from '@angular/material';
import { saveAs } from 'file-saver';
import { AuditService } from 'src/app/core/services/audit.service';
import { DataStorageService } from 'src/app/core/services/data-storage.service';
import { HeaderService } from 'src/app/core/services/header.service';

type OverallStatus = 'COMPLETED' | 'FAILED' | 'IN_PROGRESS';

const SUCCESS_CODES = ['SUCCESS', 'PROCESSED'];
const FAILURE_MARKERS = ['FAILED', 'ERROR', 'REJECTED'];
/** Once this stage succeeds, the card has been generated and can be downloaded. */
const PRINT_STAGE = 'PRINT_SERVICE';

@Component({
  selector: 'app-packet-status',
  templateUrl: './packet-status.component.html',
  styleUrls: ['./packet-status.component.scss']
})
export class PacketStatusComponent implements OnInit {
  data: any[] = null;
  messages: any = {};
  serverMessage: any = {};
  languageCode: string;

  id = '';
  searchedId = '';
  error = false;
  errorMessage = '';
  isLoading = false;
  isDownloading = false;

  overallStatus: OverallStatus;
  statusCheck = '';
  lastUpdated: string;

  constructor(
    private translate: TranslateService,
    private auditService: AuditService,
    private dataStorageService: DataStorageService,
    private headerService: HeaderService,
    private snackBar: MatSnackBar
  ) {
    this.languageCode = this.headerService.getUserPreferredLanguage();
    translate.use(this.languageCode);
    this.translate.getTranslation(this.languageCode).subscribe(response => {
      this.messages = response['packet-status'] || {};
      this.serverMessage = response['serverError'] || {};
    });
  }

  ngOnInit() {
    this.auditService.audit(5, 'ADM-045');
  }

  get isRtl(): boolean {
    return this.languageCode === 'ara';
  }

  /** The card can be downloaded once the packet has passed the print stage. */
  get canDownloadCard(): boolean {
    return !!this.data && this.overallStatus === 'COMPLETED';
  }

  search() {
    const rid = (this.id || '').trim();
    this.data = null;
    this.errorMessage = '';
    this.overallStatus = null;
    if (!rid) {
      this.error = true;
      return;
    }
    this.error = false;
    this.isLoading = true;
    this.dataStorageService.getPacketStatus(rid, this.languageCode).subscribe(
      response => {
        this.isLoading = false;
        if (response['errors'] && response['errors'].length) {
          const err = response['errors'][0];
          this.error = true;
          this.errorMessage = this.serverMessage[err.errorCode] || err.message || this.messages.error;
          return;
        }
        const list: any[] = (response['response'] && response['response']['packetStatusUpdateList']) || [];
        this.searchedId = list.length && list[0].registrationId ? list[0].registrationId : rid;
        this.data = list.slice().sort((a, b) => this.toTime(a.createdDateTimes) - this.toTime(b.createdDateTimes));
        this.computeOverallStatus();
      },
      () => {
        // Global interceptor already shows the technical error dialog.
        this.isLoading = false;
      }
    );
  }

  downloadCard() {
    if (!this.canDownloadCard || this.isDownloading) {
      return;
    }
    this.isDownloading = true;
    this.dataStorageService.downloadCard(this.searchedId).subscribe(
      (response: HttpResponse<Blob>) => {
        const blob = response.body;
        const contentType = (blob && blob.type) || response.headers.get('Content-Type') || '';
        if (!blob || !blob.size || contentType.indexOf('json') !== -1) {
          // A JSON body means the API returned an error envelope instead of the card.
          this.readBlobError(blob).then(msg => this.onDownloadFailed(msg));
          return;
        }
        saveAs(blob, this.getFileName(response, contentType));
        this.isDownloading = false;
        this.openSnackBar(this.messages.downloadSuccess);
      },
      err => {
        const body = err && err.error instanceof Blob ? err.error : null;
        this.readBlobError(body).then(msg => this.onDownloadFailed(msg));
      }
    );
  }

  stageState(item: any): 'done' | 'failed' | 'progress' {
    const code = item.statusCode || '';
    if (SUCCESS_CODES.indexOf(code) !== -1) {
      return 'done';
    }
    return this.isFailureCode(code) ? 'failed' : 'progress';
  }

  stageIcon(item: any): string {
    const state = this.stageState(item);
    return state === 'done' ? 'check' : state === 'failed' ? 'close' : 'schedule';
  }

  formatCode(code: string): string {
    if (!code) {
      return '';
    }
    return code
      .split('_')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  trackByIndex(index: number): number {
    return index;
  }

  /**
   * Overall status rules:
   *  - COMPLETED   : the packet reached the print stage successfully (card is ready),
   *                  even if some earlier stage failed and was later retried.
   *  - FAILED      : the most recent entry is a failure (processing is currently stuck).
   *  - IN_PROGRESS : anything else – an earlier failure may still be retried.
   */
  private computeOverallStatus() {
    if (!this.data.length) {
      this.overallStatus = null;
      this.statusCheck = '';
      this.lastUpdated = null;
      return;
    }
    const latest = this.data[this.data.length - 1];
    this.lastUpdated = latest.createdDateTimes;
    if (this.data.some(item => this.isPrintCompleted(item))) {
      this.overallStatus = 'COMPLETED';
      this.statusCheck = this.messages.statuscheckCompleted;
    } else if (this.isFailureCode(latest.statusCode)) {
      this.overallStatus = 'FAILED';
      this.statusCheck = this.messages.statuscheckFailed;
    } else {
      this.overallStatus = 'IN_PROGRESS';
      this.statusCheck = this.messages.statuscheckInProgress;
    }
  }

  private isPrintCompleted(item: any): boolean {
    return item.transactionTypeCode === PRINT_STAGE && SUCCESS_CODES.indexOf(item.statusCode) !== -1;
  }

  private isFailureCode(code: string): boolean {
    const c = code || '';
    return FAILURE_MARKERS.some(marker => c.indexOf(marker) !== -1);
  }

  private toTime(value: string): number {
    const t = value ? Date.parse(value) : NaN;
    return isNaN(t) ? 0 : t;
  }

  private getFileName(response: HttpResponse<Blob>, contentType: string): string {
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = /filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i.exec(disposition);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
    const ext = contentType.indexOf('png') !== -1 ? 'png'
      : contentType.indexOf('jpeg') !== -1 || contentType.indexOf('jpg') !== -1 ? 'jpg'
      : 'pdf';
    return `card_${this.searchedId}.${ext}`;
  }

  private readBlobError(blob: Blob): Promise<string> {
    if (!blob || !blob.size) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const json = JSON.parse(reader.result as string);
          const err = json && json.errors && json.errors[0];
          resolve(err ? (this.serverMessage[err.errorCode] || err.message) : (json.message || null));
        } catch (e) {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(blob);
    });
  }

  private onDownloadFailed(message: string) {
    this.isDownloading = false;
    this.openSnackBar(message || this.messages.downloadError, true);
  }

  private openSnackBar(message: string, isError = false) {
    this.snackBar.open(message, this.messages.close || 'OK', {
      duration: 5000,
      direction: this.isRtl ? 'rtl' : 'ltr',
      panelClass: isError ? 'packet-status-snackbar--error' : 'packet-status-snackbar--success'
    });
  }
}
