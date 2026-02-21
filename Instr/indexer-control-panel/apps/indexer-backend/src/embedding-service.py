#!/usr/bin/env python3
"""
GPU Embedding Service
Receives text chunks via stdin and returns embeddings via stdout (line-delimited JSON)
Uses sentence-transformers with GPU acceleration
"""

import sys
import json
import argparse
import numpy as np
import traceback
from sentence_transformers import SentenceTransformer

def pick_device(pref: str) -> str:
    """Select best available device with fallback."""
    try:
        import torch
        if pref == 'cuda' and torch.cuda.is_available():
            return 'cuda'
        if pref == 'mps' and hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            return 'mps'
    except Exception:
        pass
    return 'cpu'

def main():
    try:
        parser = argparse.ArgumentParser(description="GPU Embedding Service")
        parser.add_argument("--model", default="all-MiniLM-L6-v2", help="Model name (default: all-MiniLM-L6-v2)")
        parser.add_argument("--device", default="cuda", help="Device to use: cuda, cpu, mps (default: cuda)")
        args = parser.parse_args()
        
        # Resolve device with fallback
        resolved_device = pick_device(args.device)
        # Load model once at startup
        sys.stderr.write(json.dumps({"type": "ready", "model": args.model, "device": resolved_device}) + "\n")
        sys.stderr.flush()
        
        try:
            model = SentenceTransformer(args.model, device=resolved_device)
        except Exception as e:
            sys.stderr.write(json.dumps({"type": "error", "message": f"Failed to load model: {str(e)}", "traceback": traceback.format_exc()}) + "\n")
            sys.stderr.flush()
            sys.exit(1)
        
        sys.stderr.write(json.dumps({"type": "loaded", "device": resolved_device}) + "\n")
        sys.stderr.flush()
        
        # Process chunks line by line
        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                
                data = json.loads(line.strip())
                chunks = data.get("chunks", [])
                
                if not chunks:
                    sys.stdout.write(json.dumps({"error": "No chunks provided"}) + "\n")
                    sys.stdout.flush()
                    continue
                
                # Compute embeddings
                try:
                    embeddings = model.encode(chunks, convert_to_numpy=True, show_progress_bar=False)
                except Exception as encode_err:
                    sys.stdout.write(json.dumps({"error": f"Encoding failed: {str(encode_err)}", "traceback": traceback.format_exc()}) + "\n")
                    sys.stdout.flush()
                    continue
                
                # Handle single embedding vs batch
                if embeddings.ndim == 1:
                    embeddings = embeddings.reshape(1, -1)
                
                # Return result with actual embeddings
                result = {
                    "count": len(chunks),
                    "embedding_dim": len(embeddings[0]) if len(embeddings) > 0 else 0,
                    "embeddings": embeddings.tolist(),  # Convert to list for JSON serialization
                    "success": True
                }
                
                sys.stdout.write(json.dumps(result) + "\n")
                sys.stdout.flush()
                
            except json.JSONDecodeError as e:
                sys.stdout.write(json.dumps({"error": f"JSON decode error: {str(e)}"}) + "\n")
                sys.stdout.flush()
            except Exception as e:
                sys.stdout.write(json.dumps({"error": f"Processing error: {str(e)}", "traceback": traceback.format_exc()}) + "\n")
                sys.stdout.flush()
    except Exception as e:
        sys.stderr.write(f"Fatal error: {str(e)}\n{traceback.format_exc()}\n")
        sys.stderr.flush()
        sys.exit(1)

if __name__ == "__main__":
    main()
