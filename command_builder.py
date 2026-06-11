import json
import os

def load_config():
    if os.path.exists('config.json'):
        with open('config.json', 'r') as f:
            return json.load(f)
    return {}

def build_ffmpeg_command(input_path: str, output_path: str, profile_name: str) -> str:
    config = load_config()
    profiles = config.get("ffmpeg", {}).get("profiles", {})
    
    # 1. Safely get the profile object
    profile_data = profiles.get(profile_name, {})
    
    # 2. Extract the flags (fallback to empty string if missing)
    custom_flags = profile_data.get("flags", "")
    
    # 3. Construct the secure command
    return f'ffmpeg -y -i "{input_path}" {custom_flags} "{output_path}"'

def build_fs_command(action_name: str, source_path: str, dest_path: str = "", remote_config: dict = None) -> str:
    """Builds a file system command, injecting remote credentials if necessary."""
    config = load_config()
    actions = config.get("file_operations", {}).get("actions", {})
    
    action_data = actions.get(action_name, {})
    template = action_data.get("command_template", "")
    
    # 1. Inject local paths
    command = template.replace("{source}", source_path)
    if dest_path:
        command = command.replace("{dest}", dest_path)
        
    # 2. Inject remote credentials if this is a remote action
    if action_data.get("requires_remote") and remote_config:
        command = command.replace("{user}", remote_config.get("user", ""))
        command = command.replace("{host}", remote_config.get("host", ""))
        command = command.replace("{key_path}", remote_config.get("key_path", ""))
        
    return command