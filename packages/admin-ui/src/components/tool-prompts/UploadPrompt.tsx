/**
 * Image Upload Prompt - For uploading reference images via signed URL
 */
import { useState, useRef } from 'react';
import type { ToolPromptProps } from './types';
import { PromptSuccess, PromptError } from './PromptStatus';

export function UploadPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const args = toolCall.arguments as {
    uploadUrl: string;
    s3Key: string;
    publicUrl: string;
    category?: string;
    purpose?: string;
    description?: string;
    instructions?: string;
  };

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(file);

    setIsUploading(true);
    setError(null);

    try {
      // Upload to S3 using the signed URL
      const response = await fetch(args.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type,
        },
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
      }

      // Notify the avatar that upload completed
      await onSubmit(toolCall.id, {
        success: true,
        s3Key: args.s3Key,
        publicUrl: args.publicUrl,
        category: args.category,
        purpose: args.purpose,
        description: args.description,
        filename: file.name,
      });

      setUploaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setPreview(null);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleClick = () => fileInputRef.current?.click();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  if (uploaded) {
    return (
      <PromptSuccess message="Image uploaded successfully!">
        {preview && (
          <img src={preview} alt="Uploaded" className="w-12 h-12 rounded object-cover" />
        )}
      </PromptSuccess>
    );
  }

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-brand-500/20 rounded-lg">
          <svg className="w-5 h-5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-[var(--color-text)]">
            Upload {args.purpose === 'character_reference' ? 'Character Reference' : args.category ? `${args.category} ` : ''}Image
          </h4>
          {args.instructions && (
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">{args.instructions}</p>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleInputChange}
        className="hidden"
        disabled={disabled || isUploading}
      />

      <div
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`
          border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
          ${dragOver
            ? 'border-brand-500 bg-brand-500/10'
            : 'border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)]/50'
          }
          ${(disabled || isUploading) ? 'opacity-50 cursor-not-allowed' : ''}
        `}
      >
        {isUploading ? (
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-[var(--color-text-secondary)]">Uploading...</span>
          </div>
        ) : preview ? (
          <div className="flex flex-col items-center gap-2">
            <img src={preview} alt="Preview" className="max-w-32 max-h-32 rounded object-cover" />
            <span className="text-[var(--color-text-tertiary)] text-sm">Click or drop to replace</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <svg className="w-10 h-10 text-[var(--color-text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <span className="text-[var(--color-text-secondary)]">Drop an image here or click to browse</span>
            <span className="text-[var(--color-text-muted)] text-sm">PNG, JPG, WebP supported</span>
          </div>
        )}
      </div>

      {error && <PromptError message={error} />}
    </div>
  );
}
