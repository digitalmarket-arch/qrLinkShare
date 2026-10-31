import React, { useRef, useState } from 'react';
import {
  Upload,
  Link2,
  FileText,
  Image as ImageIcon,
  Send,
  Smartphone,
  Monitor,
  FileSpreadsheet,
  Clock,
  Bookmark,
} from 'lucide-react';
import {
  CreateShareItemPayload,
  DeviceType,
  RetentionMode,
  ShareCategory,
} from '../types/share';
import {
  detectItemCategory,
  formatBytes,
  validateShareSubmission,
} from '../utils/shareLogic';
import { QUICK_SAMPLE_PAYLOADS } from '../utils/seedData';

interface ShareComposerProps {
  roomId: string;
  defaultDevice: DeviceType;
  onShareItem: (payload: CreateShareItemPayload) => Promise<void>;
}

type ComposerTab = 'link' | 'upload' | 'text';

export const ShareComposer: React.FC<ShareComposerProps> = ({
  roomId,
  defaultDevice,
  onShareItem,
}) => {
  const [activeTab, setActiveTab] = useState<ComposerTab>('link');
  const [retentionMode, setRetentionMode] =
    useState<RetentionMode>('temporary');
  const [senderDevice, setSenderDevice] = useState<DeviceType>(defaultDevice);
  const [senderName, setSenderName] = useState<string>(
    defaultDevice === 'mobile' ? 'iPhone 16 Pro · Mobile' : 'Desktop Studio'
  );

  // Link state
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');

  // Text/Snippet state
  const [textBody, setTextBody] = useState('');
  const [textTitle, setTextTitle] = useState('');

  // File/Image/Doc upload state
  const [selectedFile, setSelectedFile] = useState<{
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    dataUrl: string;
    category: ShareCategory;
  } | null>(null);
  const [fileCaption, setFileCaption] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusFeedback, setStatusFeedback] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleDeviceToggle = (device: DeviceType) => {
    setSenderDevice(device);
    setSenderName(
      device === 'mobile' ? 'iPhone 16 Pro · Mobile' : 'Desktop Studio'
    );
  };

  const processSelectedBrowserFile = (file: File) => {
    setErrorMsg(null);
    if (file.size > 20 * 1024 * 1024) {
      setErrorMsg('File exceeds 20 MB instant transfer limit.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const category = detectItemCategory({
        fileName: file.name,
        mimeType: file.type,
      });
      setSelectedFile({
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        dataUrl,
        category,
      });
      if (!fileCaption) {
        setFileCaption(file.name.replace(/\.[^.]+$/, ''));
      }
    };
    reader.onerror = () => {
      setErrorMsg('Could not read the selected file.');
    };
    reader.readAsDataURL(file);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processSelectedBrowserFile(file);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processSelectedBrowserFile(file);
    }
  };

  const handleQuickSampleDrop = async (
    sampleKey: keyof typeof QUICK_SAMPLE_PAYLOADS
  ) => {
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      const sample = QUICK_SAMPLE_PAYLOADS[sampleKey];
      const base64 = btoa(
        encodeURIComponent(sample.rawBody).replace(
          /%([0-9A-F]{2})/g,
          (_match, p1) => String.fromCharCode(parseInt(p1, 16))
        )
      );
      const dataUrl = `data:${sample.mimeType};base64,${base64}`;
      await onShareItem({
        category: detectItemCategory({
          fileName: sample.fileName,
          mimeType: sample.mimeType,
        }),
        retentionMode,
        title: sample.title,
        content: sample.content,
        fileName: sample.fileName,
        mimeType: sample.mimeType,
        sizeBytes: sample.rawBody.length,
        dataUrl,
        senderDevice,
        senderName,
      });
      setStatusFeedback(
        `Shared "${sample.fileName}" (${retentionMode === 'temporary' ? 'Temporary Drop' : 'Saved Vault'})`
      );
      setTimeout(() => setStatusFeedback(null), 2500);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to send sample file.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusFeedback(null);

    let payload: CreateShareItemPayload;

    if (activeTab === 'link') {
      payload = {
        category: 'link',
        retentionMode,
        title: linkTitle.trim(),
        content: linkUrl.trim(),
        senderDevice,
        senderName,
      };
    } else if (activeTab === 'text') {
      payload = {
        category: 'text',
        retentionMode,
        title: textTitle.trim() || 'Shared Note / Data Snippet',
        content: textBody.trim(),
        senderDevice,
        senderName,
      };
    } else {
      if (!selectedFile) {
        setErrorMsg('Please select or drop a file, image, or document first.');
        return;
      }
      payload = {
        category: selectedFile.category,
        retentionMode,
        title: fileCaption.trim() || selectedFile.fileName,
        content: `Shared ${selectedFile.category} (${selectedFile.fileName})`,
        fileName: selectedFile.fileName,
        mimeType: selectedFile.mimeType,
        sizeBytes: selectedFile.sizeBytes,
        dataUrl: selectedFile.dataUrl,
        senderDevice,
        senderName,
      };
    }

    const validation = validateShareSubmission(payload);
    if (!validation.valid) {
      setErrorMsg(validation.error || 'Please check your input fields.');
      return;
    }

    setIsSubmitting(true);
    try {
      await onShareItem({
        ...payload,
        content: validation.normalizedUrl ?? payload.content,
        category: validation.resolvedCategory ?? payload.category,
        retentionMode: validation.resolvedRetention ?? retentionMode,
      });

      if (activeTab === 'link') {
        setLinkUrl('');
        setLinkTitle('');
      } else if (activeTab === 'text') {
        setTextBody('');
        setTextTitle('');
      } else {
        setSelectedFile(null);
        setFileCaption('');
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }

      setStatusFeedback(
        `Shared to ${roomId} as ${retentionMode === 'temporary' ? 'Temporary Link/Drop' : 'Saved Vault Item'}`
      );
      setTimeout(() => setStatusFeedback(null), 2500);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not share item.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section
      aria-labelledby="composer-heading"
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5"
    >
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div>
          <h2
            id="composer-heading"
            className="text-base font-semibold text-slate-900 dark:text-slate-100"
          >
            Share Link, Doc, or Data to Desktop
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Choose Temporary Link or Saved Vault for Room {roomId}
          </p>
        </div>

        {/* Sender Perspective Toggle */}
        <div
          role="group"
          aria-label="Send from device perspective"
          className="inline-flex items-center p-1 bg-slate-100 dark:bg-slate-800 rounded-lg"
        >
          <button
            type="button"
            onClick={() => handleDeviceToggle('mobile')}
            className={`min-h-[32px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              senderDevice === 'mobile'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>From Phone</span>
          </button>
          <button
            type="button"
            onClick={() => handleDeviceToggle('desktop')}
            className={`min-h-[32px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              senderDevice === 'desktop'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>From Desktop</span>
          </button>
        </div>
      </div>

      {/* Dual Retention Mode Selector (Option 1: Temporary Link vs Option 2: Saved Links/Data/Doc) */}
      <div className="mb-3">
        <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
          Storage & Retention Mode
        </span>
        <div
          role="group"
          aria-label="Storage and retention mode"
          className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg"
        >
          <button
            type="button"
            onClick={() => setRetentionMode('temporary')}
            className={`min-h-[40px] px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
              retentionMode === 'temporary'
                ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 shadow-2xs font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>Temporary Link / Drop</span>
          </button>

          <button
            type="button"
            onClick={() => setRetentionMode('saved')}
            className={`min-h-[40px] px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
              retentionMode === 'saved'
                ? 'bg-white dark:bg-slate-900 text-indigo-700 dark:text-indigo-400 shadow-2xs font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Bookmark className="w-3.5 h-3.5 shrink-0" />
            <span>Saved Link / Data / Doc</span>
          </button>
        </div>
      </div>

      {/* Mode Tabs */}
      <div
        role="tablist"
        aria-label="Share payload type"
        className="grid grid-cols-3 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg mb-4"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'link'}
          onClick={() => {
            setActiveTab('link');
            setErrorMsg(null);
          }}
          className={`min-h-[42px] px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
            activeTab === 'link'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Link2 className="w-3.5 h-3.5 shrink-0" />
          <span>Link / URL</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'upload'}
          onClick={() => {
            setActiveTab('upload');
            setErrorMsg(null);
          }}
          className={`min-h-[42px] px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
            activeTab === 'upload'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Upload className="w-3.5 h-3.5 shrink-0" />
          <span>Files & Docs</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'text'}
          onClick={() => {
            setActiveTab('text');
            setErrorMsg(null);
          }}
          className={`min-h-[42px] px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
            activeTab === 'text'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <FileText className="w-3.5 h-3.5 shrink-0" />
          <span>Text / Data</span>
        </button>
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-3">
        {activeTab === 'link' && (
          <div className="space-y-3">
            <div>
              <label
                htmlFor="share-link-url"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Destination URL (Opens in Desktop Browser)
              </label>
              <input
                id="share-link-url"
                type="url"
                value={linkUrl}
                onChange={(e) => {
                  setLinkUrl(e.target.value);
                  if (errorMsg) setErrorMsg(null);
                }}
                placeholder="https://figma.com/file/mobile-handoff"
                className="w-full min-h-[40px] px-3 py-2 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label
                htmlFor="share-link-title"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Link Label (Optional)
              </label>
              <input
                id="share-link-title"
                type="text"
                value={linkTitle}
                onChange={(e) => setLinkTitle(e.target.value)}
                placeholder="e.g. Design System Prototype v4"
                className="w-full min-h-[40px] px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
        )}

        {activeTab === 'upload' && (
          <div>
            <input
              ref={fileInputRef}
              id="file-upload-input"
              type="file"
              onChange={handleFileInputChange}
              className="sr-only"
              aria-label="Choose file, image, or document to share"
            />

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-xl p-4 text-center transition-colors ${
                isDragging
                  ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30'
                  : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/50'
              }`}
            >
              {selectedFile ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {selectedFile.fileName}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                    {selectedFile.category.toUpperCase()} ·{' '}
                    {formatBytes(selectedFile.sizeBytes)}
                  </p>
                  <div className="flex items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 cursor-pointer"
                    >
                      Change File
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedFile(null)}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:underline cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    Drop any photo, PDF, Word/Markdown doc, ZIP, or file here
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Supports PNG, JPG, SVG, PDF, DOCX, CSV, MD, JSON up to 20 MB
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-1 min-h-[38px] px-4 py-2 text-xs font-medium text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Browse Local Files</span>
                  </button>
                </div>
              )}
            </div>

            <div className="mt-3">
              <label
                htmlFor="file-caption-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Display Title (Optional)
              </label>
              <input
                id="file-caption-input"
                type="text"
                value={fileCaption}
                onChange={(e) => setFileCaption(e.target.value)}
                placeholder="e.g. Whiteboard Photo or Signed Contract PDF"
                className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {/* One-Click Instant Sample Phone Drops */}
            <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800/80">
              <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-2">
                Quick-Beam Sample Payloads (Instant Test):
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => handleQuickSampleDrop('photoSvg')}
                  className="min-h-[36px] px-2.5 py-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/90 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center justify-center gap-1 whitespace-nowrap truncate cursor-pointer"
                >
                  <ImageIcon className="w-3 h-3 text-indigo-600 dark:text-indigo-400 shrink-0" />
                  <span>Sample Photo</span>
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => handleQuickSampleDrop('docMarkdown')}
                  className="min-h-[36px] px-2.5 py-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/90 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center justify-center gap-1 whitespace-nowrap truncate cursor-pointer"
                >
                  <FileText className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>Sample Doc</span>
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => handleQuickSampleDrop('csvDataset')}
                  className="min-h-[36px] px-2.5 py-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/90 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center justify-center gap-1 whitespace-nowrap truncate cursor-pointer"
                >
                  <FileSpreadsheet className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
                  <span>Sample CSV</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'text' && (
          <div className="space-y-3">
            <div>
              <label
                htmlFor="share-text-title"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Snippet Title (Optional)
              </label>
              <input
                id="share-text-title"
                type="text"
                value={textTitle}
                onChange={(e) => setTextTitle(e.target.value)}
                placeholder="e.g. Phone Clipboard Note / API Token"
                className="w-full min-h-[40px] px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label
                htmlFor="share-text-body"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Text / Data Payload
              </label>
              <textarea
                id="share-text-body"
                rows={3}
                value={textBody}
                onChange={(e) => {
                  setTextBody(e.target.value);
                  if (errorMsg) setErrorMsg(null);
                }}
                placeholder="Paste text, terminal command, JSON data, or code snippet..."
                className="w-full px-3 py-2 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
        )}

        {errorMsg && (
          <p
            role="alert"
            className="text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900/60 rounded-lg px-3 py-2"
          >
            {errorMsg}
          </p>
        )}

        {statusFeedback && (
          <p
            role="status"
            className="text-xs font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900/60 rounded-lg px-3 py-2"
          >
            {statusFeedback}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full min-h-[42px] px-4 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer"
        >
          <Send className="w-3.5 h-3.5" />
          <span>
            {isSubmitting
              ? 'Sending...'
              : activeTab === 'link'
                ? retentionMode === 'temporary'
                  ? 'Share Temporary Link to Desktop'
                  : 'Save Link to Vault'
                : activeTab === 'text'
                  ? retentionMode === 'temporary'
                    ? 'Share Temporary Note'
                    : 'Save Data / Note to Vault'
                  : retentionMode === 'temporary'
                    ? 'Beam Temporary File'
                    : 'Save File / Doc to Vault'}
          </span>
        </button>
      </form>
    </section>
  );
};
