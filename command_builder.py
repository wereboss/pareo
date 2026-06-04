import json
import os

def load_config():
    if os.path.exists('config.json'):
        with open('config.json', 'r') as f:
            return json.load(f)
    return {}

def build_ffmpeg_command(input_path: str, output_path: str) -> str:
    config = load_config()
    flags = config.get("ffmpeg", {}).get("default_flags", "-y")
    
    # Wrap paths in quotes to handle spaces in file names securely
    return f'ffmpeg {flags} -i "{input_path}" "{output_path}"'