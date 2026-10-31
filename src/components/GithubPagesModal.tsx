import React, { useState } from 'react';
import {
  X,
  Check,
  Copy,
  Globe,
  Terminal,
  ExternalLink,
  CheckCircle2,
} from 'lucide-react';
import { buildGithubPagesUrl } from '../utils/shareLogic';
import { QrCodeView } from './QrCodeView';

interface GithubPagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
}

export const GithubPagesModal: React.FC<GithubPagesModalProps> = ({
  isOpen,
  onClose,
  roomId,
}) => {
  const [githubUsername, setGithubUsername] = useState('digitalmartket333');
  const [repoName, setRepoName] = useState('qrLinkShare');
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  if (!isOpen) return null;

  const livePagesUrl = buildGithubPagesUrl(githubUsername, repoName, roomId);
  const mobilePairPagesUrl = `${livePagesUrl}&device=mobile`;

  const gitPushCommands = `git init
git add .
git commit -m "Deploy qrLinkShare to GitHub Pages"
git branch -M main
git remote add origin https://github.com/${githubUsername.trim() || 'your-username'}/${repoName.trim() || 'qrLinkShare'}.git
git push -u origin main`;

  const ghPagesCliCommand = `npm run build && npx gh-pages -d dist`;

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback
    }
    setCopiedCmd(key);
    setTimeout(() => setCopiedCmd(null), 1800);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gh-pages-modal-title"
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h2
              id="gh-pages-modal-title"
              className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2"
            >
              <Globe className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
              <span>Publish to GitHub Pages</span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Static bundle, GitHub Actions workflow (.github/workflows/deploy.yml), and serverless QR payload mode are pre-configured.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close GitHub Pages modal"
            className="min-h-[36px] min-w-[36px] p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 bg-slate-100 dark:bg-slate-800 rounded-lg flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Readiness Checklist */}
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>Workflow Ready</span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-mono">
              .github/workflows/deploy.yml
            </p>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>Relative Asset Base</span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-mono">
              base: './' + 404.html
            </p>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>Static Edge Mode</span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-mono">
              URL #share + LocalStorage
            </p>
          </div>
        </div>

        {/* GitHub Username & Repo Config + Live GitHub Pages QR Preview */}
        <div className="mt-5 grid grid-cols-1 md:grid-cols-12 gap-5 items-center bg-slate-50/70 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800 rounded-xl p-4">
          <div className="md:col-span-7 space-y-3">
            <div>
              <label
                htmlFor="gh-username-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                GitHub Username / Organization
              </label>
              <input
                id="gh-username-input"
                type="text"
                value={githubUsername}
                onChange={(e) => setGithubUsername(e.target.value)}
                placeholder="digitalmartket333"
                className="w-full min-h-[38px] px-3 py-1.5 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label
                htmlFor="gh-repo-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Repository Name
              </label>
              <input
                id="gh-repo-input"
                type="text"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                placeholder="qrLinkShare"
                className="w-full min-h-[38px] px-3 py-1.5 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                Target GitHub Pages URL:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1.5 truncate">
                  {livePagesUrl}
                </code>
                <a
                  href={livePagesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open target GitHub Pages URL"
                  className="min-h-[34px] px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg hover:bg-slate-100 flex items-center gap-1 shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          </div>

          <div className="md:col-span-5 flex flex-col items-center">
            <QrCodeView
              value={mobilePairPagesUrl}
              size={140}
              downloadFileName={`gh-pages-${repoName}-${roomId}`}
              copyLabel="Copy Pages URL"
              label="GitHub Pages Mobile QR"
            />
          </div>
        </div>

        {/* Step-by-Step Deployment Instructions */}
        <div className="mt-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>1. Push to GitHub (Triggers Automatic GitHub Pages Action)</span>
            </h3>
            <button
              type="button"
              onClick={() => handleCopy('git', gitPushCommands)}
              className="min-h-[30px] px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg flex items-center gap-1 cursor-pointer"
            >
              {copiedCmd === 'git' ? (
                <>
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>Copy Commands</span>
                </>
              )}
            </button>
          </div>
          <pre className="p-3 rounded-xl bg-slate-900 text-slate-100 text-xs font-mono overflow-x-auto leading-relaxed">
            {gitPushCommands}
          </pre>

          <div className="flex items-center justify-between pt-1">
            <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              2. Enable GitHub Actions Source (One-Time Repo Setting)
            </h3>
            <button
              type="button"
              onClick={() => handleCopy('cli', ghPagesCliCommand)}
              className="min-h-[30px] px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg flex items-center gap-1 cursor-pointer"
            >
              {copiedCmd === 'cli' ? (
                <>
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span>Copied CLI</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>Copy gh-pages CLI</span>
                </>
              )}
            </button>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            In your GitHub repository, go to{' '}
            <span className="font-mono font-medium text-slate-900 dark:text-slate-200">
              Settings → Pages → Build and deployment
            </span>{' '}
            and set <strong>Source</strong> to <strong>GitHub Actions</strong>. Alternatively, run{' '}
            <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono">
              {ghPagesCliCommand}
            </code>{' '}
            to publish the <code className="font-mono">dist/</code> directory directly to the <code className="font-mono">gh-pages</code> branch.
          </p>
        </div>

        <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
