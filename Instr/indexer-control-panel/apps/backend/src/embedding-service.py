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
    parser = argparse.ArgumentParser(description="GPU Embedding Service")
    parser.add_argument("--model", default="all-MiniLM-L6-v2", help="Model name (default: all-MiniLM-L6-v2)")
    parser.add_argument("--device", default="cuda", help="Device to use: cuda, cpu, mps (default: cuda)")
    args = parser.parse_args()
    
    # Resolve device with fallback
    resolved_device = pick_device(args.device)
    # Load model once at startup
    print(json.dumps({"type": "ready", "model": args.model, "device": resolved_device}), file=sys.stderr)
    sys.stderr.flush()
    
    try:
        model = SentenceTransformer(args.model, device=resolved_device)
    except Exception as e:
        print(json.dumps({"type": "error", "message": f"Failed to load model: {str(e)}"}), file=sys.stderr)
        sys.exit(1)
    
    print(json.dumps({"type": "loaded", "device": resolved_device}), file=sys.stderr)
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
                print(json.dumps({"error": "No chunks provided"}))
                continue
            
            # Compute embeddings
            embeddings = model.encode(chunks, convert_to_numpy=True, show_progress_bar=False)
            
            # Return result with actual embeddings
            result = {
                "count": len(chunks),
                "embedding_dim": len(embeddings[0]) if len(embeddings) > 0 else 0,
                "embeddings": embeddings.tolist(),  # Convert to list for JSON serialization
                "success": True
            }
            
            print(json.dumps(result))
            sys.stdout.flush()
            
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"JSON decode error: {str(e)}"}))
        except Exception as e:
            print(json.dumps({"error": f"Processing error: {str(e)}"}))
            sys.stderr.write(f"Error: {str(e)}\n")
            sys.stderr.flush()

if __name__ == "__main__":
    main()
